import { describe, expect, it } from 'vitest'
import { buildSidebar, prRef, pruneAgentState, runsShownAt, type AgentState, type Grouping, type SidebarNode, type TabInfo } from '../desktop/src/sidebar.ts'
import type { CursorSession, LinearIssue, PullRequest, Snapshot } from '../src/shared/types.ts'

const NOW = Date.parse('2026-11-19T12:00:00Z')

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `id-${number}`,
    key: `acme/app#${number}`,
    repo: 'acme/app',
    repoName: 'app',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    baseRef: 'main',
    headRef: `branch-${number}`,
    ci: 'green',
    linearIssues: [],
    initiativeIds: [],
    awaitingYouCount: 0,
    commentAwaitingCount: 0,
    unreadCount: 0,
    reviewCommentAwaitingCount: 0,
    ...over,
  } as PullRequest
}

function issue(identifier: string, projectName: string | null): LinearIssue {
  return { identifier, title: `Title ${identifier}`, url: null, projectId: projectName, projectName }
}

function session(agentId: string, over: Partial<CursorSession> = {}): CursorSession {
  return {
    agentId,
    runId: 'run-1',
    kind: 'ci',
    prompt: null,
    status: 'running',
    result: null,
    branch: null,
    createdAt: '2026-11-19T11:56:00Z',
    updatedAt: '2026-11-19T11:56:00Z',
    ...over,
  }
}

function snapshot(mine: PullRequest[], review: PullRequest[] = []): Snapshot {
  return {
    viewer: 'me',
    syncedAt: null,
    mineSyncedAt: null,
    reviewSyncedAt: null,
    repos: [],
    pullRequests: mine,
    reviewPullRequests: review,
    initiatives: [{ id: 'init-1', name: 'Onboarding', createdAt: '', updatedAt: '' }],
    linearConfigured: true,
    warning: null,
  }
}

function tab(id: number, url: string, over: Partial<TabInfo> = {}): TabInfo {
  return { id, pinned: false, url, placedUrl: url, title: `Page ${id}`, favicon: null, loading: false, parent: null, ...over }
}

const HOME = tab(0, 'http://127.0.0.1:4318/', { pinned: true, title: 'Pull requests' })
const QUIET: AgentState = { since: '2026-11-01T00:00:00Z', seen: {}, dismissed: [] }

function build(tabs: TabInfo[], data: Snapshot, over: { grouping?: Grouping; activeId?: number; collapsed?: string[]; agentState?: AgentState; byIssue?: boolean; held?: string[] } = {}) {
  return buildSidebar({
    tabs: [HOME, ...tabs],
    activeId: over.activeId ?? 0,
    data,
    grouping: over.grouping ?? 'match',
    prefs: { mineByIssue: over.byIssue ?? true, reviewByIssue: over.byIssue ?? true },
    collapsed: over.collapsed ?? [],
    agentState: over.agentState ?? QUIET,
    held: over.held,
    now: NOW,
  })
}

function outline(nodes: SidebarNode[]): string[] {
  return nodes.map((node) => (node.kind === 'tab' ? `${'  '.repeat(node.depth)}${node.row.number === null ? node.row.title : `#${node.row.number}`}` : `${node.kind}:${node.title}`))
}

describe('prRef', () => {
  it('reads the same pull request from GitHub and Graphite', () => {
    expect(prRef('https://github.com/Acme/App/pull/12')).toEqual({ key: 'acme/app#12', bare: true })
    expect(prRef('https://app.graphite.com/github/pr/acme/app/12')).toEqual({ key: 'acme/app#12', bare: true })
  })

  it('tells a place inside the pull request from the pull request itself', () => {
    expect(prRef('https://github.com/acme/app/pull/12/files')?.bare).toBe(false)
    expect(prRef('https://github.com/acme/app/pull/12#issuecomment-1')?.bare).toBe(false)
  })

  it('ignores other pages', () => {
    expect(prRef('https://github.com/acme/app/pulls')).toBeNull()
    expect(prRef('https://app.graphite.com/')).toBeNull()
  })
})

describe('sidebar tabs', () => {
  const data = snapshot([
    pr(1, { linearIssues: [issue('ENG-1', 'Invitations')], ci: 'red', awaitingYouCount: 2 }),
    pr(2, { linearIssues: [issue('ENG-1', 'Invitations')] }),
    pr(3, { initiativeIds: ['init-1'] }),
    pr(4),
  ])
  const tabs = [
    tab(1, 'https://github.com/acme/app/pull/4'),
    tab(2, 'https://app.graphite.com/github/pr/acme/app/1'),
    tab(3, 'https://github.com/acme/app/actions/runs/9', { parent: 2, title: 'CI run' }),
    tab(4, 'https://linear.app/acme/issue/ENG-1', { title: 'ENG-1' }),
    tab(5, 'https://github.com/acme/app/pull/3'),
    tab(6, 'https://github.com/acme/app/pull/2/files'),
  ]

  it('groups as the dashboard does, with ungrouped pull requests and other pages last', () => {
    expect(outline(build(tabs, data).nodes)).toEqual([
      'group:Invitations',
      'issue:ENG-1 · Title ENG-1',
      '  #1',
      '    CI run',
      '  #2',
      'group:Onboarding',
      '  #3',
      'group:Ungrouped',
      '  #4',
      'label:Other',
      'ENG-1',
    ])
  })

  it('drops the issue level when the dashboard does not group by issue', () => {
    expect(outline(build(tabs, data, { byIssue: false }).nodes).slice(0, 4)).toEqual(['group:Invitations', '  #1', '    CI run', '  #2'])
  })

  it('lists tabs in the order they were opened when grouping is off', () => {
    expect(outline(build(tabs, data, { grouping: 'none' }).nodes)).toEqual(['#4', '#1', '  CI run', 'ENG-1', '#3', '#2'])
  })

  it('groups by initiative', () => {
    expect(outline(build(tabs, data, { grouping: 'initiative' }).nodes).slice(0, 3)).toEqual(['group:Onboarding', '  #3', 'group:Untagged'])
  })

  it('hides the rows of a collapsed group but keeps them in the tab order', () => {
    const model = build(tabs, data, { collapsed: ['project:Invitations'] })
    expect(outline(model.nodes).slice(0, 2)).toEqual(['group:Invitations', 'group:Onboarding'])
    expect(model.order).toEqual([2, 3, 6, 5, 1, 4])
  })

  it('shows status and what is waiting on the user', () => {
    const row = build(tabs, data).nodes.flatMap((node) => (node.kind === 'tab' && node.row.number === 1 ? [node.row] : []))[0]
    expect(row).toMatchObject({ title: 'Change 1', ci: 'red', needs: 2 })
  })

  it('names where the active tab sits', () => {
    expect(build(tabs, data, { activeId: 3 }).crumb).toEqual(['Invitations', 'ENG-1 · Title ENG-1', 'CI run'])
    expect(build(tabs, data, { activeId: 2 }).crumb.at(-1)).toBe('#1 Change 1')
  })

  it('relabels a tab that left its pull request, and keeps its place until it is filed again', () => {
    const away = tab(2, 'https://app.graphite.com/', { placedUrl: 'https://app.graphite.com/github/pr/acme/app/1', title: 'Graphite' })
    const stays = build([away], data, { activeId: 2 })
    expect(outline(stays.nodes)).toEqual(['group:Invitations', 'issue:ENG-1 · Title ENG-1', '  Graphite'])
    const filed = build([{ ...away, placedUrl: away.url }], data)
    expect(outline(filed.nodes)).toEqual(['Graphite'])
  })

  it('counts a review pull request by what the reviewer has not read', () => {
    const review = snapshot([], [pr(9, { unreadCount: 3, awaitingYouCount: 5 })])
    const model = build([tab(1, 'https://github.com/acme/app/pull/9')], review)
    expect(model.nodes.flatMap((node) => (node.kind === 'tab' ? [node.row.needs] : []))).toEqual([3])
  })
})

describe('sidebar agents', () => {
  const running = session('bc-run')
  const done = session('bc-done', { kind: 'conflict', status: 'finished', updatedAt: '2026-11-19T10:00:00Z' })
  const failed = session('bc-fail', { kind: 'thread', prompt: 'src/deals/invite.ts:88\n\nUse the list', status: 'failed', updatedAt: '2026-11-19T11:00:00Z' })
  const old = session('bc-old', { status: 'finished', updatedAt: '2026-10-01T00:00:00Z' })
  const data = snapshot([pr(1, { cursorSessions: [running, done] }), pr(2, { cursorSessions: [failed, old] })])

  it('lists running agents, then unread ones, and folds the rest away', () => {
    const model = build([], data)
    expect(model.agents.map((row) => [row.label, row.number, row.mark, row.age])).toEqual([
      ['CI failure', 1, 'running', '4m'],
      ['invite.ts:88', 2, 'failed', '1h'],
      ['Merge conflict', 1, 'unread', '2h'],
    ])
    expect(model.earlier.map((row) => row.key)).toEqual(['bc-old:run-1'])
    expect([model.running, model.unread]).toEqual([1, 2])
  })

  it('moves an agent that was looked at, or dismissed, to earlier', () => {
    const state: AgentState = { ...QUIET, seen: { 'bc-done:run-1': '2026-11-19T10:30:00Z' }, dismissed: ['bc-run:run-1'] }
    const model = build([], data, { agentState: state })
    expect(model.agents.map((row) => row.key)).toEqual(['bc-fail:run-1'])
    expect(model.earlier.map((row) => row.key)).toEqual(['bc-run:run-1', 'bc-done:run-1', 'bc-old:run-1'])
  })

  it('keeps an agent read in the open tab in its row until another tab is chosen', () => {
    const state: AgentState = { ...QUIET, seen: { 'bc-done:run-1': '2026-11-19T10:30:00Z' } }
    const model = build([], data, { agentState: state, held: ['bc-done:run-1'] })
    expect(model.agents.map((row) => [row.key, row.mark])).toEqual([
      ['bc-run:run-1', 'running'],
      ['bc-fail:run-1', 'failed'],
      ['bc-done:run-1', 'read'],
    ])
    expect(model.unread).toBe(1)
    expect(model.earlier.map((row) => row.key)).toEqual(['bc-old:run-1'])
  })

  it('keeps an agent tab out of the tab list and ties it to its row', () => {
    const model = build([tab(7, 'https://cursor.com/agents/bc-run'), tab(8, 'https://github.com/acme/app/pull/1')], data, { activeId: 7 })
    expect(outline(model.nodes)).toEqual(['group:Ungrouped', '  #1'])
    expect(model.agents[0]).toMatchObject({ key: 'bc-run:run-1', tabId: 7 })
    expect(model.order).toEqual([7, 8])
    expect(model.crumb).toEqual(['Agents', 'CI failure · #1'])
    expect(model.strip.find((item) => item.id === 7)).toMatchObject({ title: 'CI failure', agent: 'running' })
    expect(model.nodes.flatMap((node) => (node.kind === 'tab' ? [node.row.agent] : []))).toEqual([true])
  })

  it('finds the unread runs a tab is showing', () => {
    expect(runsShownAt('https://cursor.com/agents/bc-done', data, QUIET)).toEqual(['bc-done:run-1'])
    expect(runsShownAt('https://cursor.com/agents/bc-run', data, QUIET)).toEqual([])
    expect(runsShownAt('https://example.com/bc-done', data, QUIET)).toEqual([])
  })

  it('forgets runs the snapshot no longer has', () => {
    const state: AgentState = { ...QUIET, seen: { 'bc-done:run-1': 'x', 'gone:run-1': 'x' }, dismissed: ['gone:run-1', 'bc-run:run-1'] }
    expect(pruneAgentState(state, data)).toEqual({ ...QUIET, seen: { 'bc-done:run-1': 'x' }, dismissed: ['bc-run:run-1'] })
  })
})
