import { describe, expect, it } from 'vitest'
import { buildSidebar, drawStacks, isAppLink, linearRef, linearStayUrl, prRef, pruneAgentState, runsShownAt, shareUrl, type AgentState, type Grouping, type SidebarNode, type TabInfo } from '../desktop/src/sidebar.ts'
import { buildStacks } from '../src/shared/stacks.ts'
import { isT3Handoff, isT3PairLink, t3PromptAction, t3PromptUpdate } from '../desktop/src/t3-prompt.ts'
import type { AgentSession, LinearIssue, PullRequest, Snapshot } from '../src/shared/types.ts'

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
    defaultBranch: 'main',
    // A lower number was updated more recently, so the dashboard lists it first.
    createdAt: new Date(NOW - number * 60_000).toISOString(),
    updatedAt: new Date(NOW - number * 60_000).toISOString(),
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

function session(agentId: string, over: Partial<AgentSession> = {}): AgentSession {
  return {
    agentId,
    provider: 'cursor',
    environmentId: null,
    url: null,
    unreachableSince: null,
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

function build(tabs: TabInfo[], data: Snapshot, over: { grouping?: Grouping; activeId?: number; collapsed?: string[]; agentState?: AgentState; flat?: string[]; held?: string[]; linearByProject?: boolean } = {}) {
  return buildSidebar({
    tabs: [HOME, ...tabs],
    activeId: over.activeId ?? 0,
    data,
    grouping: over.grouping ?? 'match',
    prefs: { mineFlat: over.flat ?? [], reviewFlat: over.flat ?? [] },
    collapsed: over.collapsed ?? [],
    linearByProject: over.linearByProject,
    agentState: over.agentState ?? QUIET,
    held: over.held,
    now: NOW,
  })
}

function outline(nodes: SidebarNode[]): string[] {
  return nodes.map((node) => (node.kind === 'tab' ? `${'  '.repeat(node.depth)}${node.row.number === null ? node.row.title : `#${node.row.number}`}` : `${node.kind}:${node.title}`))
}

describe('the pairing note on T3 Code’s hand-off page', () => {
  it('knows the hand-off page from the T3 Code on this machine and from other sites', () => {
    expect(isT3Handoff('https://app.t3.codes/threads/env-1/thread-1')).toBe(true)
    expect(isT3Handoff('http://127.0.0.1:3773/threads/env-1/thread-1')).toBe(false)
    expect(isT3Handoff('https://app.t3.codes/pair')).toBe(false)
    expect(isT3Handoff('https://evil.example/?https://app.t3.codes/threads/x')).toBe(false)
  })

  it('knows a pairing link for the T3 Code on this machine', () => {
    expect(isT3PairLink('http://127.0.0.1:3773/pair#token=ABC')).toBe(true)
    expect(isT3PairLink('http://127.0.0.1:3773/pair')).toBe(false)
    expect(isT3PairLink('http://127.0.0.1:3773/threads/a/b#token=ABC')).toBe(false)
    expect(isT3PairLink('https://evil.example/pair#token=ABC')).toBe(false)
    expect(isT3PairLink('not a url')).toBe(false)
  })

  it('reads a button press from the address the button links to', () => {
    expect(t3PromptAction('pr-dash-t3:pair')).toBe('pair')
    expect(t3PromptAction('pr-dash-t3:settings')).toBe('settings')
    expect(t3PromptAction('pr-dash-t3:never')).toBe('never')
    expect(t3PromptAction('pr-dash-t3:anything-else')).toBeNull()
    expect(t3PromptAction('https://app.t3.codes/threads/x')).toBeNull()
  })

  it('carries a failure onto the note as text, not as markup or script', () => {
    const script = t3PromptUpdate({ busy: false, error: '"); alert(1); ("' })
    expect(script).toContain(JSON.stringify('"); alert(1); ("'))
  })
})

describe('app links', () => {
  it('hands T3 Code and Cursor links to the system, and nothing else', () => {
    expect(isAppLink('t3code://threads/env-1/thread-1')).toBe(true)
    expect(isAppLink('cursor://anysphere.cursor-deeplink/background-agent?bcId=bc-1')).toBe(true)
    expect(isAppLink('https://app.t3.codes/threads/env-1/thread-1')).toBe(false)
    expect(isAppLink('linear://issue/ENG-1')).toBe(false)
    expect(isAppLink('file:///etc/hosts')).toBe(false)
  })
})

describe('prRef', () => {
  it('reads the same pull request from GitHub and Graphite', () => {
    expect(prRef('https://github.com/Acme/App/pull/12')).toEqual({ key: 'acme/app#12', site: 'github', bare: true })
    expect(prRef('https://app.graphite.com/github/pr/acme/app/12')).toEqual({ key: 'acme/app#12', site: 'graphite', bare: true })
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

describe('Linear pages', () => {
  it('reads the issue or project an address shows', () => {
    expect(linearRef('https://linear.app/acme/issue/eng-12/some-title')).toEqual({ issue: 'ENG-12', project: null })
    expect(linearRef('https://linear.app/acme/project/Billing-0a1b2c3d4e5f/overview')).toEqual({ issue: null, project: 'billing-0a1b2c3d4e5f' })
    expect(linearRef('https://linear.app/acme/inbox')).toEqual({ issue: null, project: null })
    expect(linearRef('https://github.com/acme/app/pull/12')).toBeNull()
  })

  it('marks an address so Linear stays in the window, once, and takes the mark off again', () => {
    const stay = linearStayUrl('https://linear.app/acme/issue/ENG-12/title?a=1#comment')
    expect(stay).toBe('https://linear.app/acme/issue/ENG-12/title?a=1&noRedirect=1#comment')
    expect(linearStayUrl(stay!)).toBeNull()
    expect(linearStayUrl('https://github.com/acme/app/pull/12')).toBeNull()
    expect(shareUrl(stay!)).toBe('https://linear.app/acme/issue/ENG-12/title?a=1#comment')
    expect(shareUrl('https://github.com/acme/app/pull/12?noRedirect=1')).toBe('https://github.com/acme/app/pull/12?noRedirect=1')
  })

  const data = snapshot([pr(1, { linearIssues: [issue('ENG-1', 'Billing')] })])
  const tabs = [
    tab(1, 'https://github.com/acme/app/pull/1'),
    tab(2, 'https://linear.app/acme/issue/ENG-9/unknown?noRedirect=1', { parent: 1 }),
    tab(3, 'https://example.com/'),
    tab(4, 'https://linear.app/acme/issue/ENG-1/known'),
    tab(5, 'https://linear.app/acme/project/billing-0a1b2c3d4e5f/overview'),
  ]

  it('lists them in their own section, wherever they were opened from', () => {
    const model = build(tabs, data, { activeId: 2 })
    expect(outline(model.nodes).slice(-7)).toEqual(['  #1', 'label:Linear', 'Page 2', 'Page 4', 'Page 5', 'label:Other', 'Page 3'])
    expect(model.crumb).toEqual(['Linear', 'Page 2'])
  })

  it('groups them by project when asked, with the unknown ones last', () => {
    const model = build(tabs, data, { linearByProject: true, activeId: 5, collapsed: ['linear:none'] })
    expect(outline(model.nodes).slice(-7)).toEqual(['label:Linear', 'group:Billing', '  Page 4', '  Page 5', 'group:No project', 'label:Other', 'Page 3'])
    expect(model.crumb).toEqual(['Linear', 'Billing', 'Page 5'])
  })

  it('leaves them in the flat list when nothing is grouped', () => {
    expect(outline(build(tabs, data, { grouping: 'none' }).nodes)).toEqual(['#1', 'Page 2', 'Page 3', 'Page 4', 'Page 5'])
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
    tab(4, 'https://example.com/notes', { title: 'ENG-1' }),
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

  it('drops the issue level of a section the dashboard does not group by issue', () => {
    expect(outline(build(tabs, data, { flat: ['project:Invitations'] }).nodes).slice(0, 4)).toEqual(['group:Invitations', '  #1', '    CI run', '  #2'])
  })

  it('lists tabs in the order they were opened when grouping is off', () => {
    expect(outline(build(tabs, data, { grouping: 'none' }).nodes)).toEqual(['#4', '#1', '  CI run', 'ENG-1', '#3', '#2'])
  })

  it('groups by initiative', () => {
    expect(outline(build(tabs, data, { grouping: 'initiative' }).nodes).slice(0, 3)).toEqual(['group:Onboarding', '  #3', 'group:Untagged'])
  })

  it('keeps a tab that has left its pull request under that pull request', () => {
    // Tab 7 was on #3 and followed a link in place; tab 8 was opened from it.
    const wandered = [
      tab(5, 'https://github.com/acme/app/pull/4'),
      tab(7, 'https://github.com/acme/app/actions/runs/9', { origin: 'acme/app#3', title: 'CI run' }),
      tab(8, 'https://vercel.com/acme/app', { parent: 7, origin: 'acme/app#3', title: 'Preview' }),
    ]
    expect(outline(build(wandered, data).nodes)).toEqual(['group:Onboarding', '  CI run', '  Preview', 'group:Ungrouped', '  #4'])
    expect(build(wandered, data, { activeId: 7 }).crumb).toEqual(['Onboarding', 'CI run'])
  })

  it('nests a tab that has left its pull request under a tab still on it', () => {
    const wandered = [tab(5, 'https://github.com/acme/app/pull/3'), tab(7, 'https://github.com/acme/app/actions/runs/9', { origin: 'acme/app#3', title: 'CI run' })]
    expect(outline(build(wandered, data).nodes)).toEqual(['group:Onboarding', '  #3', '    CI run'])
  })

  it('files a page under Other or Linear when its pull request is unknown or it is on Linear', () => {
    const wandered = [
      tab(7, 'https://example.com/', { origin: 'acme/app#99', title: 'Unknown' }),
      tab(8, 'https://linear.app/acme/issue/ENG-1/known', { origin: 'acme/app#3', title: 'Issue' }),
    ]
    expect(outline(build(wandered, data).nodes)).toEqual(['label:Linear', 'Issue', 'label:Other', 'Unknown'])
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

describe('stack rails', () => {
  // 10, 11 and 12 in a line, with 20 and 21 branching off 11.
  const on = (number: number, base: number | null) => pr(number, { baseRef: base ? `branch-${base}` : 'main' })
  const prs = [on(10, null), on(11, 10), on(12, 11), on(20, 11), on(21, 20)]
  const stack = buildStacks(prs)[0]!
  const stacks = new Map(prs.map((item) => [item.key, stack]))
  const key = (number: number) => `acme/app#${number}`
  const rails = (numbers: number[]) => drawStacks(numbers.map(key), stacks).map((item) => item!.rail)

  it('gives a branch its own lane and joins it where it is based', () => {
    const drawn = rails([21, 20, 12, 11, 10])
    expect(drawn.map((rail) => rail.lanes)).toEqual([2, 2, 2, 2, 2])
    expect(drawn.map((rail) => rail.lane)).toEqual([0, 0, 1, 0, 0])
    expect(drawn[2]).toMatchObject({ up: null, down: 'solid', through: [{ lane: 0, line: 'solid' }] })
    expect(drawn[3]).toMatchObject({ up: 'solid', down: 'solid', joins: [{ lane: 1, line: 'solid' }] })
    expect(drawn[4]).toMatchObject({ up: 'solid', down: null })
  })

  it('dots the line across pull requests that are not open, and stubs the ends that go on', () => {
    const [top, bottom] = rails([12, 10])
    expect(top).toMatchObject({ lanes: 1, up: null, down: 'dotted' })
    expect(bottom).toMatchObject({ up: 'dotted', down: null })
    expect(rails([11])[0]).toMatchObject({ up: 'stub', down: 'stub' })
  })

  it('carries lanes past a page nested under a pull request', () => {
    const drawn = drawStacks([key(21), key(20), key(12), key(11)], stacks)
    expect(drawn[2]!.passing).toMatchObject({ lane: null, through: [{ lane: 0, line: 'solid' }, { lane: 1, line: 'solid' }] })
    expect(drawn[2]!.note).toBe('Based on #11')
    expect(drawn[3]!.note).toBe('Based on #10, which is not open here')
  })

  it('leaves rows that are not in a stack alone, and starts a new rail after one', () => {
    const drawn = drawStacks([key(12), null, key(11)], stacks)
    expect(drawn[1]).toBeNull()
    expect(drawn[0]!.rail.down).toBe('stub')
    expect(drawn[2]!.rail.up).toBe('stub')
  })

  it('orders a stack top first in the sidebar and draws its rail', () => {
    const tabs = [10, 12, 11].map((number, index) => tab(index + 1, `https://github.com/acme/app/pull/${number}`))
    const nodes = build(tabs, snapshot(prs)).nodes
    expect(outline(nodes)).toEqual(['group:Ungrouped', '  #12', '  #11', '  #10'])
    expect(nodes.flatMap((node) => (node.kind === 'tab' ? [[node.rail?.up, node.rail?.down]] : []))).toEqual([[null, 'solid'], ['solid', 'solid'], ['solid', null]])
  })
})

describe('sidebar agents', () => {
  const running = session('bc-run')
  const done = session('bc-done', { kind: 'conflict', status: 'finished', updatedAt: '2026-11-19T10:00:00Z' })
  const failed = session('bc-fail', { kind: 'thread', prompt: 'src/deals/invite.ts:88\n\nUse the list', status: 'failed', updatedAt: '2026-11-19T11:00:00Z' })
  const old = session('bc-old', { status: 'finished', updatedAt: '2026-10-01T00:00:00Z' })
  const data = snapshot([pr(1, { agentSessions: [running, done] }), pr(2, { agentSessions: [failed, old] })])

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

  it('keeps an agent tab out of the strip unless it is the one being looked at', () => {
    const tabs = [tab(7, 'https://cursor.com/agents/bc-done'), tab(8, 'https://github.com/acme/app/pull/1'), tab(9, 'about:blank', { starting: { key: 'acme/app#2', kind: 'prompt', prompt: 'Tidy' } })]
    expect(build(tabs, data, { activeId: 8 }).strip.map((item) => item.id)).toEqual([0, 8])
    expect(build(tabs, data, { activeId: 7 }).strip.map((item) => item.id)).toEqual([0, 7, 8])
  })

  it('lists a tab opened for an agent that is still starting with the agents, under its pull request', () => {
    const starting = { key: 'acme/app#2', kind: 'prompt' as const, prompt: 'Tidy the imports' }
    const model = build([tab(7, 'about:blank', { starting })], data, { activeId: 7 })
    expect(outline(model.nodes)).toEqual([])
    expect(model.agents[0]).toMatchObject({ key: 'starting:7', label: 'Tidy the imports', number: 2, mark: 'running', tabId: 7 })
    expect(model.running).toBe(2)
    expect(model.crumb).toEqual(['Agents', 'Tidy the imports · #2'])
    expect(model.strip.find((item) => item.id === 7)).toMatchObject({ title: 'Tidy the imports', agent: 'running' })
  })

  it('gives that tab to the run once the run is known, before the tab has reached its page', () => {
    const started = session('bc-new', { kind: 'prompt', prompt: 'Tidy the imports\n\nAll of them.', createdAt: '2026-11-19T11:59:00Z' })
    const next = snapshot([pr(1, { agentSessions: [running] }), pr(2, { agentSessions: [started] })])
    const model = build([tab(7, 'about:blank', { starting: { key: 'acme/app#2', kind: 'prompt', prompt: 'Tidy the imports' } })], next)
    expect(model.agents.map((row) => [row.key, row.tabId])).toEqual([
      ['bc-new:run-1', 7],
      ['bc-run:run-1', null],
    ])
  })

  it('files such a tab as any other when its pull request is not listed', () => {
    const model = build([tab(7, 'about:blank', { starting: { key: 'acme/app#9', kind: 'ci', prompt: null } })], data)
    expect(outline(model.nodes)).toEqual(['Page 7'])
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

describe('pull requests that merged or closed', () => {
  const old = session('bc-old', { status: 'finished', updatedAt: '2026-10-01T00:00:00Z' })
  const gone = (number: number, outcome: 'merged' | 'closed', over: Partial<PullRequest> = {}) => {
    const last = pr(number, over)
    return { key: last.key, repo: last.repo, repoName: last.repoName, number, title: last.title, url: last.url, author: 'me', list: 'mine' as const, outcome, at: '2026-11-19T11:00:00Z', linearIssues: last.linearIssues, initiativeIds: last.initiativeIds, agentSessions: last.agentSessions ?? [] }
  }
  const data: Snapshot = {
    ...snapshot([pr(1, { linearIssues: [issue('ENG-1', 'Deals')] })]),
    departed: [gone(2, 'merged', { linearIssues: [issue('ENG-1', 'Deals')], agentSessions: [old] }), gone(3, 'closed')],
  }
  const tabs = [tab(1, 'https://github.com/acme/app/pull/2'), tab(2, 'https://github.com/acme/app/pull/1'), tab(3, 'https://github.com/acme/app/pull/3'), tab(4, 'https://example.com/')]

  it('keeps their tabs where they were, after the open ones, with a mark in place of checks', () => {
    const model = build(tabs, data)
    expect(outline(model.nodes)).toEqual(['group:Deals', 'issue:ENG-1 · Title ENG-1', '  #1', '  #2', 'group:Ungrouped', '  #3', 'label:Other', 'Page 4'])
    const rows = model.nodes.flatMap((node) => (node.kind === 'tab' ? [node.row] : []))
    expect(rows.map((row) => [row.number, row.gone, row.ci])).toEqual([[1, null, 'green'], [2, 'merged', null], [3, 'closed', null], [null, null, null]])
    expect(model.strip.map((item) => item.gone)).toEqual([null, 'merged', null, 'closed', null])
  })

  it('keeps their agents under earlier, and what was read about them', () => {
    expect(build([], data).earlier.map((row) => [row.key, row.number])).toEqual([['bc-old:run-1', 2]])
    const state: AgentState = { ...QUIET, seen: { 'bc-old:run-1': 'x' } }
    expect(pruneAgentState(state, data)).toEqual(state)
  })
})
