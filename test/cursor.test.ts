import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { agentBlocker, leadingStatus, parseAgentRequest, sessionNote, sessionStatusLabel, type ThreadFix } from '../src/shared/agents.ts'
import { cursorLinks, cursorPushedBranch, cursorSessionStatus } from '../src/shared/cursor.ts'
import type { Check, AgentSession, PullRequest } from '../src/shared/types.ts'
import { agentTask } from '../src/server/agent-tasks.ts'
import { openDatabase } from '../src/server/db.ts'
import { pullRequest } from './support/pull.ts'

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    agentId: 'bc-123',
    provider: 'cursor',
    environmentId: null,
    url: null,
    unreachableSince: null,
    runId: 'run-1',
    kind: 'conflict',
    prompt: null,
    status: 'running',
    result: null,
    branch: null,
    createdAt: '2026-10-21T00:01:00Z',
    updatedAt: '2026-10-21T00:01:00Z',
    ...patch,
  }
}

function failed(name: string): Check {
  return {
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    required: true,
    url: `https://github.com/acme/app/actions/runs/9/job/${name}`,
    workflowName: 'CI',
    workflowRunId: 9,
    startedAt: '2026-10-21T00:00:00Z',
    completedAt: '2026-10-21T00:05:00Z',
  }
}

function pull(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    ...pullRequest(1),
    key: 'acme/app#1',
    number: 1,
    repo: 'acme/app',
    title: 'One',
    url: 'https://github.com/acme/app/pull/1',
    headRef: 'feature',
    baseRef: 'main',
    conflict: false,
    checks: [],
    linearIssues: [],
    agentSessions: [],
    ...patch,
  }
}

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-cursor-'))
  return path.join(dir, 'dash.sqlite')
}

describe('cursor sessions', () => {
  it('maps Cursor run statuses and keeps an unknown status active', () => {
    expect(cursorSessionStatus('CREATING')).toBe('creating')
    expect(cursorSessionStatus('RUNNING')).toBe('running')
    expect(cursorSessionStatus('FINISHED')).toBe('finished')
    expect(cursorSessionStatus('ERROR')).toBe('failed')
    expect(cursorSessionStatus('CANCELLED')).toBe('cancelled')
    expect(cursorSessionStatus('EXPIRED')).toBe('expired')
    expect(cursorSessionStatus('SOMETHING_NEW')).toBe('running')
  })

  it('prefers a running session over a finished one', () => {
    expect(leadingStatus(['finished', 'failed', 'running'])).toBe('running')
    expect(leadingStatus([])).toBeNull()
  })

  it('labels statuses without naming the task', () => {
    expect(sessionStatusLabel('running')).toBe('Running')
    expect(sessionStatusLabel('finished')).toBe('Finished')
  })

  it('reads the pushed branch and builds both session links', () => {
    expect(cursorPushedBranch({ branches: [{ branch: null }, { branch: 'feature' }] })).toBe('feature')
    expect(cursorPushedBranch(undefined)).toBeNull()
    expect(cursorLinks('bc-123')).toEqual({
      webUrl: 'https://cursor.com/agents/bc-123',
      desktopUrl: 'cursor://anysphere.cursor-deeplink/background-agent?bcId=bc-123',
    })
  })

  it('keeps every session attached to a pull request across snapshot saves, newest first', () => {
    const db = openDatabase(tempDb())
    const pullRequest = { key: 'acme/app#1', title: 'One' } as PullRequest
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:00:00Z',
      pullRequests: [pullRequest],
      linearConfigured: false,
      warning: null,
    })
    db.saveAgentSession('acme/app#1', session())
    db.saveAgentSession(
      'acme/app#1',
      session({ agentId: 'bc-456', kind: 'prompt', prompt: 'Tidy the tests', createdAt: '2026-10-21T00:05:00Z' }),
    )

    expect(db.snapshot().pullRequests[0]?.agentSessions?.map((item) => item.agentId)).toEqual(['bc-456', 'bc-123'])
    expect(db.snapshot().pullRequests[0]?.agentSessions?.[0]).toMatchObject({ kind: 'prompt', prompt: 'Tidy the tests' })

    db.saveAgentSession('acme/app#1', session({ status: 'finished', result: 'Done', updatedAt: '2026-10-21T00:06:00Z' }))
    const saved = db.snapshot().pullRequests[0]?.agentSessions?.find((item) => item.agentId === 'bc-123')
    expect(saved).toMatchObject({ status: 'finished', result: 'Done', kind: 'conflict', createdAt: '2026-10-21T00:01:00Z' })

    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:02:00Z',
      pullRequests: db.snapshot().pullRequests,
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().pullRequests[0]?.agentSessions).toHaveLength(2)

    const review = { key: 'acme/app#2', title: 'Theirs', author: 'ada' } as PullRequest
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:03:00Z',
      pullRequests: [pullRequest],
      reviewPullRequests: [review],
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().reviewPullRequests.map((item) => item.key)).toEqual(['acme/app#2'])
    expect(db.snapshot().reviewPullRequests[0]?.agentSessions).toEqual([])
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:04:00Z',
      pullRequests: [pullRequest],
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().reviewPullRequests.map((item) => item.key)).toEqual(['acme/app#2'])
  })

  it('moves sessions from the one-per-pull-request table as conflict sessions', () => {
    const file = tempDb()
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE cursor_sessions (
        pr_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, branch TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO cursor_sessions VALUES ('acme/app#1', 'bc-old', 'run-1', 'finished', 'Resolved', 'feature', '2026-10-20T00:00:00Z');
    `)
    legacy.close()

    const db = openDatabase(file)
    expect(db.agentSessions()).toEqual([
      {
        prKey: 'acme/app#1',
        session: session({
          agentId: 'bc-old',
          provider: 'cursor',
          environmentId: null,
          url: null,
          unreachableSince: null,
          status: 'finished',
          result: 'Resolved',
          branch: 'feature',
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T00:00:00Z',
        }),
      },
    ])
    expect(() => openDatabase(file)).not.toThrow()
  })
})

describe('agent shortcuts', () => {
  it('reads a request body', () => {
    expect(parseAgentRequest({ kind: 'ci' })).toEqual({ kind: 'ci' })
    expect(parseAgentRequest({ kind: 'prompt', prompt: 'Rename it' })).toEqual({ kind: 'prompt', prompt: 'Rename it' })
    expect(parseAgentRequest({ kind: 'prompt' })).toBeNull()
    expect(parseAgentRequest({ kind: 'thread', thread: thread(), prompt: 'Keep the name' })).toEqual({
      kind: 'thread',
      thread: thread(),
      prompt: 'Keep the name',
    })
    expect(parseAgentRequest({ kind: 'thread', thread: thread() })).toEqual({ kind: 'thread', thread: thread(), prompt: null })
    expect(parseAgentRequest({ kind: 'thread', prompt: 'Missing the thread' })).toBeNull()
    expect(parseAgentRequest({ kind: 'thread', thread: { ...thread(), outdated: 'yes' } })).toBeNull()
    expect(parseAgentRequest({ kind: 'thread', thread: { ...thread(), id: "x'; rm -rf /" } })).toBeNull()
    expect(parseAgentRequest({ kind: 'deploy' })).toBeNull()
    expect(parseAgentRequest(null)).toBeNull()
  })

  it('runs one shortcut of a kind at a time, and prompts side by side', () => {
    expect(agentBlocker(pull(), { kind: 'conflict' })).toMatch(/no longer has a merge conflict/)
    expect(agentBlocker(pull({ conflict: true }), { kind: 'conflict' })).toBeNull()
    expect(agentBlocker(pull({ conflict: true, agentSessions: [session()] }), { kind: 'conflict' })).toMatch(/already resolving/)
    expect(agentBlocker(pull({ conflict: true, agentSessions: [session({ status: 'finished' })] }), { kind: 'conflict' })).toBeNull()

    expect(agentBlocker(pull(), { kind: 'ci' })).toMatch(/no failing checks/)
    expect(agentBlocker(pull({ checks: [failed('test')] }), { kind: 'ci' })).toBeNull()
    expect(agentBlocker(pull({ checks: [failed('test')], agentSessions: [session({ kind: 'ci' })] }), { kind: 'ci' })).toMatch(
      /already investigating/,
    )

    const busy = pull({ agentSessions: [session({ kind: 'prompt', prompt: 'One' })] })
    expect(agentBlocker(busy, { kind: 'prompt', prompt: 'Two' })).toBeNull()
    expect(agentBlocker(busy, { kind: 'prompt', prompt: '   ' })).toMatch(/Write a prompt/)

    expect(agentBlocker(pull(), { kind: 'thread', thread: thread(), prompt: null })).toBeNull()
    expect(agentBlocker(pull(), { kind: 'thread', thread: thread({ comments: [{ author: 'ada', body: '   ' }] }), prompt: null })).toMatch(
      /nothing for an agent/,
    )
    expect(agentBlocker(pull(), { kind: 'thread', thread: thread(), prompt: 'x'.repeat(8001) })).toMatch(/under 8,000/)
    expect(agentBlocker(busy, { kind: 'thread', thread: thread(), prompt: 'Look again' })).toBeNull()
  })

  it('attaches the pull request to every prompt', () => {
    const pr = pull({
      checks: [failed('lint'), failed('test')],
      linearIssues: [{ identifier: 'ENG-7', title: 'Fix login', url: 'https://linear.app/x/ENG-7', projectId: null, projectName: null }],
    })
    const custom = agentTask(pr, { kind: 'prompt', prompt: '  Rename the helper to match the module.\nKeep exports.  ' })
    expect(custom.name).toBe('#1: Rename the helper to match the module.')
    expect(custom.prompt.startsWith('Rename the helper to match the module.\nKeep exports.\n')).toBe(true)
    for (const task of [custom, agentTask(pr, { kind: 'conflict' }), agentTask(pr, { kind: 'ci' })]) {
      expect(task.prompt).toContain('https://github.com/acme/app/pull/1')
      expect(task.prompt).toContain('Head branch feature, base branch main')
      expect(task.prompt).toContain('- ENG-7: Fix login (https://linear.app/x/ENG-7)')
      expect(task.prompt).toContain('Do not create a separate pull request.')
    }

    const ci = agentTask(pr, { kind: 'ci' })
    expect(ci.name).toBe('Investigate #1 CI failure')
    expect(ci.prompt).toContain('- lint (workflow CI, required, run 9): https://github.com/acme/app/actions/runs/9/job/lint')
    expect(ci.prompt).toContain('- test (workflow CI, required, run 9)')
    expect(ci.prompt).toContain('gh run view <run> --repo acme/app --log-failed')
    expect(ci.prompt).toContain('do not push. Report what you found instead.')
  })

  it('asks a conflict agent to restack what is stacked above', () => {
    const pr = pull()
    const alone = agentTask(pr, { kind: 'conflict' })
    expect(alone.prompt).not.toContain('stack')
    expect(alone.prompt).toContain("Work on the pull request's existing head branch (feature) and push any commits there.")

    const second = pull({ key: 'acme/app#2', number: 2, headRef: 'second', baseRef: 'feature' })
    const third = pull({ key: 'acme/app#3', number: 3, headRef: 'third', baseRef: 'second' })
    const one = agentTask(pr, { kind: 'conflict' }, [second])
    expect(one.prompt).toContain('one pull request is stacked above it. Restack it once #1 is resolved')
    expect(one.prompt).toContain('Rebase its head branch onto the updated tip')

    const stacked = agentTask(pr, { kind: 'conflict' }, [second, third]).prompt
    expect(stacked).toContain('2 pull requests are stacked above it. Restack them once #1 is resolved')
    expect(stacked.indexOf('- #2: head branch second, based on feature')).toBeLessThan(stacked.indexOf('- #3: head branch third, based on second'))
    expect(stacked).toContain('In that order, rebase each head branch onto the updated tip')
    expect(stacked).toContain('--force-with-lease')
    expect(stacked).toContain('Work on the existing head branches named above (feature first) and push only to them.')
    expect(stacked).not.toContain('push any commits there')

    // Only a conflict restacks.
    expect(agentTask(pr, { kind: 'ci' }, [second]).prompt).not.toContain('stacked above')
  })

  it('asks Cursor to fix a review thread, and adds a custom prompt on top', () => {
    const pr = pull()
    const naive = agentTask(pr, { kind: 'thread', thread: thread(), prompt: null })
    expect(naive.name).toBe('Fix #1 src/web/queue.tsx:12-18')
    expect(naive.prompt).toContain('Address this review thread on pull request #1.')
    expect(naive.prompt).toContain('Verify the finding before changing anything.')
    expect(naive.prompt).toContain('Pushing back is a valid outcome.')
    expect(naive.prompt).toContain('src/web/queue.tsx:12-18 (outdated)')
    expect(naive.prompt).toContain('https://github.com/acme/app/pull/1#discussion_r1')
    expect(naive.prompt).toContain('ada:\nPlease rename this.')
    expect(naive.prompt).toContain('```diff')
    expect(naive.prompt).toContain('do not push')
    expect(naive.prompt).toContain('reply on the review thread itself')
    expect(naive.prompt).toContain('Then resolve the thread.')
    expect(naive.prompt).toContain('Leave it unresolved only when the reviewer needs to weigh in')
    expect(naive.prompt).toContain('addPullRequestReviewThreadReply')
    expect(naive.prompt).toContain('resolveReviewThread')
    expect(naive.prompt).toContain('-f id=PRRT_kwDOabc123')
    expect(naive.prompt).not.toContain('Additional instructions:')
    expect(agentTask(pr, { kind: 'thread', thread: thread({ id: null }), prompt: null }).prompt).not.toContain('resolveReviewThread')
    expect(sessionNote({ kind: 'thread', thread: thread(), prompt: null })).toBe('src/web/queue.tsx:12-18')

    const custom = agentTask(pr, { kind: 'thread', thread: thread(), prompt: '  Keep the public name.\nAdd a test.  ' })
    expect(custom.name).toBe('#1: Keep the public name.')
    expect(custom.prompt).toContain('Additional instructions:\nKeep the public name.\nAdd a test.')
    expect(custom.prompt).toContain('https://github.com/acme/app/pull/1')
    expect(custom.prompt).toContain('Do not create a separate pull request.')
    expect(sessionNote({ kind: 'thread', thread: thread(), prompt: '  Keep the public name.  ' })).toBe(
      'src/web/queue.tsx:12-18\n\nKeep the public name.',
    )
  })

  it('shortens a huge review thread before the agent sees it', () => {
    const parsed = parseAgentRequest({
      kind: 'thread',
      thread: thread({ diffHunk: 'x'.repeat(20_000), comments: [{ author: 'ada', body: 'y'.repeat(7_000) }] }),
    })
    expect(parsed?.kind).toBe('thread')
    if (parsed?.kind !== 'thread') return
    expect(parsed.thread.truncated).toBe(true)
    expect(parsed.thread.diffHunk).toHaveLength(16_000)
    expect(parsed.thread.comments[0]?.body).toHaveLength(6_000)
    expect(agentTask(pull(), parsed).prompt).toContain('Part of this thread was left out.')
  })
})

function thread(patch: Partial<ThreadFix> = {}): ThreadFix {
  return {
    id: 'PRRT_kwDOabc123',
    path: 'src/web/queue.tsx',
    line: 18,
    startLine: 12,
    url: 'https://github.com/acme/app/pull/1#discussion_r1',
    outdated: true,
    diffHunk: '@@ -1 +1 @@\n-old\n+new\n',
    truncated: false,
    comments: [{ author: 'ada', body: 'Please rename this.' }],
    ...patch,
  }
}
