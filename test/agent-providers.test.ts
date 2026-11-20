import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { providerFor, sessionActive, sessionLinks, leadingStatus, t3ThreadUrl } from '../src/shared/agents.ts'
import type { AgentSession } from '../src/shared/types.ts'
import { AgentUnavailable, refreshSessions, type AgentProvider } from '../src/server/agent-provider.ts'
import { openDatabase } from '../src/server/db.ts'
import { originRepo, t3Origin, t3Projects, t3Session, worktreeNote } from '../src/server/t3.ts'

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: 't3',
    agentId: 'mcp:thread-1',
    runId: 'run-1',
    kind: 'ci',
    prompt: null,
    status: 'creating',
    result: null,
    branch: null,
    environmentId: null,
    url: null,
    unreachableSince: null,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    ...patch,
  }
}

function provider(id: AgentProvider['id'], read: AgentProvider['read']): AgentProvider {
  return { id, health: async () => ({ state: 'ready', detail: null }), start: async () => session(), read }
}

describe('agent routing', () => {
  it('uses the default unless the repository names another provider', () => {
    const routing = { defaultProvider: 't3' as const, repos: { 'acme/web': 'cursor' as const } }
    expect(providerFor(routing, 'acme/app')).toBe('t3')
    expect(providerFor(routing, 'acme/web')).toBe('cursor')
    expect(providerFor(undefined, 'acme/app')).toBe('cursor')
  })

  it('stores the default, each repository choice, and drops a repository with nothing set', () => {
    const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'pr-dash-agents-')), 'db.sqlite'))
    expect(db.agentRouting()).toEqual({ defaultProvider: 'cursor', repos: {} })
    db.setDefaultProvider('t3')
    db.setRepoAgent('acme/app', { provider: null, environmentId: null, checkout: '~/code/app' })
    db.setRepoAgent('acme/web', { provider: 'cursor', environmentId: null, checkout: null })
    expect(db.agentRouting()).toEqual({ defaultProvider: 't3', repos: { 'acme/web': 'cursor' } })
    expect(db.snapshot().agents).toEqual({ defaultProvider: 't3', repos: { 'acme/web': 'cursor' } })
    expect(db.repoAgents().get('acme/app')).toEqual({ provider: null, environmentId: null, checkout: '~/code/app' })
    db.setRepoAgent('acme/app', { provider: null, environmentId: null, checkout: null })
    expect(db.repoAgents().has('acme/app')).toBe(false)
  })

  it('keeps the provider, environment, link and unreachable mark of a saved session', () => {
    const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'pr-dash-agents-')), 'db.sqlite'))
    db.saveAgentSession('acme/app#1', session({ environmentId: 'env-1', url: 'https://t3.example/thread' }))
    db.saveAgentSession('acme/app#1', session({ environmentId: 'env-1', url: 'https://t3.example/thread', unreachableSince: '2026-11-20T10:05:00Z' }))
    expect(db.agentSessions()[0]?.session).toMatchObject({
      provider: 't3',
      environmentId: 'env-1',
      url: 'https://t3.example/thread',
      unreachableSince: '2026-11-20T10:05:00Z',
    })
  })
})

describe('session status', () => {
  it('treats a session waiting for an answer as active and the first to show', () => {
    expect(sessionActive('waiting')).toBe(true)
    expect(leadingStatus(['finished', 'running', 'waiting'])).toBe('waiting')
  })

  it('links a T3 Code session to its thread once it has one', () => {
    expect(sessionLinks(session())).toEqual({ webUrl: null, appUrl: null })
    expect(sessionLinks(session({ url: 'https://t3.example/thread' })).webUrl).toBe('https://t3.example/thread')
    expect(sessionLinks(session({ provider: 'cursor', agentId: 'bc-1' })).webUrl).toBe('https://cursor.com/agents/bc-1')
  })
})

describe('T3 Code thread links', () => {
  const link = 'https://app.t3.codes/threads/env-1/mcp%3Athread-1'

  it('hands off to the T3 Code app until this browser is paired', () => {
    expect(sessionLinks(session({ url: link }))).toEqual({ webUrl: link, appUrl: null })
  })

  it('shows the thread from the T3 Code on this machine once paired, and keeps the hand-off', () => {
    expect(sessionLinks(session({ url: link }), 'http://127.0.0.1:3773')).toEqual({
      webUrl: 'http://127.0.0.1:3773/threads/env-1/mcp%3Athread-1',
      appUrl: link,
    })
  })

  it('has no local page for a session without a link, or a link that is not a thread', () => {
    expect(t3ThreadUrl('http://127.0.0.1:3773', null)).toBeNull()
    expect(t3ThreadUrl('http://127.0.0.1:3773', 'https://app.t3.codes/pair')).toBeNull()
    expect(t3ThreadUrl(null, link)).toBeNull()
  })

  it('reads where T3 Code answers from what it wrote when it started', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-dash-t3-'))
    expect(t3Origin(home)).toBeNull()
    mkdirSync(path.join(home, 'userdata'))
    writeFileSync(path.join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ origin: 'http://127.0.0.1:3773', port: 3773 }))
    expect(t3Origin(home)).toBe('http://127.0.0.1:3773')
    writeFileSync(path.join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ origin: 'file:///etc' }))
    expect(t3Origin(home)).toBeNull()
  })
})

describe('refreshing sessions', () => {
  it('marks a session whose provider is out of reach, without changing its status', async () => {
    const saved: AgentSession[] = []
    const down = provider('t3', async () => {
      throw new AgentUnavailable('unreachable', 'T3 Code is not running on this machine.')
    })
    await refreshSessions({ t3: down, cursor: down }, [{ prKey: 'acme/app#1', session: session({ status: 'running' }) }], (_key, next) => saved.push(next))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ status: 'running', updatedAt: '2026-11-20T10:00:00Z' })
    expect(saved[0]?.unreachableSince).toBeTruthy()
  })

  it('keeps the first time a provider stopped answering, and clears it once it answers', async () => {
    const saved: AgentSession[] = []
    const since = '2026-11-20T10:05:00Z'
    const down = provider('t3', async () => {
      throw new AgentUnavailable('unreachable', 'down')
    })
    const up = provider('t3', async (current) => ({ ...current, status: 'finished' }))
    const item = { prKey: 'acme/app#1', session: session({ status: 'running', unreachableSince: since }) }
    await refreshSessions({ t3: down, cursor: down }, [item], (_key, next) => saved.push(next))
    expect(saved).toHaveLength(0)
    await refreshSessions({ t3: up, cursor: up }, [item], (_key, next) => saved.push(next))
    expect(saved[0]).toMatchObject({ status: 'finished', unreachableSince: null })
  })

  it('leaves finished sessions alone, and a session alone when its read fails for another reason', async () => {
    const saved: AgentSession[] = []
    const broken = provider('t3', async () => {
      throw new Error('unreadable')
    })
    await refreshSessions(
      { t3: broken, cursor: broken },
      [
        { prKey: 'acme/app#1', session: session({ status: 'finished' }) },
        { prKey: 'acme/app#2', session: session({ status: 'running' }) },
      ],
      (_key, next) => saved.push(next),
    )
    expect(saved).toHaveLength(0)
  })
})

describe('T3 Code threads', () => {
  const now = '2026-11-20T10:10:00Z'

  it('reads a finished thread: status, reply and link', () => {
    const next = t3Session(
      session(),
      {
        thread: { status: 'completed', link: 'https://t3.example/thread', latestRunId: 'run-1', activeRunId: null, pendingRequestCount: 0 },
        messages: [
          { role: 'user', runId: 'run-1', text: 'Fix it' },
          { role: 'assistant', runId: 'run-1', text: 'Fixed and pushed.' },
        ],
      },
      now,
    )
    expect(next).toMatchObject({ status: 'finished', result: 'Fixed and pushed.', url: 'https://t3.example/thread', updatedAt: now })
  })

  it('says a thread that failed without a reply could not run', () => {
    const next = t3Session(session(), { thread: { status: 'failed' }, messages: [{ role: 'user', text: 'Fix it' }] }, now)
    expect(next.status).toBe('failed')
    expect(next.result).toMatch(/could not run this thread/)
  })

  it('shows a thread with a pending request as waiting, with what it asked', () => {
    const next = t3Session(
      session(),
      { thread: { status: 'running', pendingRequestCount: 1, latestRunId: 'run-1' }, messages: [{ role: 'assistant', runId: 'run-1', text: 'May I push?' }] },
      now,
    )
    expect(next).toMatchObject({ status: 'waiting', result: 'May I push?' })
  })

  it('follows the latest run, and ignores a reply from an earlier one', () => {
    const next = t3Session(
      session({ result: null }),
      { thread: { status: 'running', latestRunId: 'run-2', activeRunId: 'run-2' }, messages: [{ role: 'assistant', runId: 'run-1', text: 'Old reply' }] },
      now,
    )
    expect(next).toMatchObject({ status: 'running', runId: 'run-2', result: null })
  })

  it('goes by the active run for a status it does not know', () => {
    expect(t3Session(session(), { thread: { status: 'compacting', activeRunId: 'run-1' } }, now).status).toBe('running')
    expect(t3Session(session(), { thread: { status: 'idle', activeRunId: null } }, now).status).toBe('finished')
    expect(t3Session(session(), { thread: { status: 'preparing' } }, now).status).toBe('creating')
  })

  it('reads the repository from a GitHub remote', () => {
    expect(originRepo('git@github.com:acme/app.git')).toBe('acme/app')
    expect(originRepo('https://github.com/acme/app')).toBe('acme/app')
    expect(originRepo('https://github.com/acme/app.git\n')).toBe('acme/app')
    expect(originRepo('https://gitlab.com/acme/app.git')).toBeNull()
  })

  it('tells the agent to push its new branch onto the pull request branch', () => {
    expect(worktreeNote('feat/login')).toContain('git push origin HEAD:feat/login')
  })

  it('lists the projects T3 Code has, newest first, without deleted or archived ones', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-dash-t3-'))
    mkdirSync(path.join(home, 'userdata'))
    const state = new DatabaseSync(path.join(home, 'userdata', 'statev2.sqlite'))
    state.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, archived_at TEXT);
      INSERT INTO projection_projects VALUES
        ('p1', 'app', '/code/app', '2026-11-01', NULL, NULL),
        ('p2', 'web', '/code/web', '2026-11-02', NULL, NULL),
        ('p3', 'gone', '/code/gone', '2026-11-03', '2026-11-04', NULL),
        ('p4', 'shelved', '/code/shelved', '2026-11-03', NULL, '2026-11-04');
    `)
    state.close()
    expect(t3Projects(home)).toEqual([
      { id: 'p2', title: 'web', root: '/code/web' },
      { id: 'p1', title: 'app', root: '/code/app' },
    ])
  })

  it('reads no projects when T3 Code has no state, or its state is not the shape expected', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pr-dash-t3-'))
    expect(t3Projects(home)).toEqual([])
    mkdirSync(path.join(home, 'userdata'))
    const state = new DatabaseSync(path.join(home, 'userdata', 'statev2.sqlite'))
    state.exec('CREATE TABLE something_else (id TEXT)')
    state.close()
    expect(t3Projects(home)).toEqual([])
  })
})
