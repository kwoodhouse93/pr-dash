import { agentKindLabel } from '../../src/shared/agents.ts'
import { cursorLinks, cursorSessionActive } from '../../src/shared/cursor.ts'
import { buildStacks } from '../../src/shared/stacks.ts'
import type { CiLevel, CursorSession, PullRequest, Snapshot } from '../../src/shared/types.ts'

// What the sidebar and the tab strip show, worked out from the open tabs and
// the dashboard's snapshot. Nothing here touches Electron.

export type Grouping = 'match' | 'none' | 'project' | 'issue' | 'initiative' | 'stack'

export const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'match', label: 'As dashboard' },
  { value: 'none', label: 'None' },
  { value: 'project', label: 'Project' },
  { value: 'issue', label: 'Issue' },
  { value: 'initiative', label: 'Initiative' },
  { value: 'stack', label: 'Stack' },
]

export function isGrouping(value: unknown): value is Grouping {
  return GROUPINGS.some((item) => item.value === value)
}

export type TabInfo = {
  id: number
  pinned: boolean
  url: string
  /** The address the tab's place in the sidebar comes from. It catches up with `url` when the tab stops being the active one. */
  placedUrl: string
  title: string
  favicon: string | null
  loading: boolean
  /** The tab this one was opened from. */
  parent: number | null
}

/** Whether each dashboard list groups pull requests under their Linear issue. */
export type DashboardPrefs = { mineByIssue: boolean; reviewByIssue: boolean }

export type AgentState = {
  /** Agents that finished before this are not news. */
  since: string
  /** When each agent run was last looked at, by run key. */
  seen: Record<string, string>
  dismissed: string[]
}

export type TabRow = {
  id: number
  title: string
  favicon: string | null
  loading: boolean
  number: number | null
  ci: CiLevel | null
  /** Comments and threads waiting on the user. */
  needs: number
  /** A Cursor agent is running on this pull request. */
  agent: boolean
}

export type SidebarNode =
  | { kind: 'group'; id: string; title: string; count: number; open: boolean }
  | { kind: 'issue'; title: string }
  | { kind: 'label'; title: string }
  | { kind: 'tab'; depth: number; row: TabRow }

export type AgentMark = 'running' | 'unread' | 'failed' | 'read'

export type AgentRow = {
  key: string
  label: string
  number: number
  mark: AgentMark
  age: string
  url: string
  tabId: number | null
}

export type StripTab = {
  id: number
  pinned: boolean
  title: string
  favicon: string | null
  loading: boolean
  ci: CiLevel | null
  agent: AgentMark | null
}

export type SidebarModel = {
  nodes: SidebarNode[]
  agents: AgentRow[]
  earlier: AgentRow[]
  running: number
  unread: number
  strip: StripTab[]
  /** Tabs other than the dashboard, top to bottom as the sidebar lists them. */
  order: number[]
  /** Where the active tab sits: its groups, then its own name. */
  crumb: string[]
}

export type PrRef = { key: string; bare: boolean }

const PR_URLS = [
  /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)([/?#].*)?$/,
  /^https:\/\/app\.graphite\.com\/github\/pr\/([^/?#]+\/[^/?#]+)\/(\d+)([/?#].*)?$/,
]

/** The pull request an address shows, on GitHub or Graphite. `bare` is false when the address points at a place inside it. */
export function prRef(url: string): PrRef | null {
  for (const pattern of PR_URLS) {
    const match = pattern.exec(url)
    if (!match) continue
    const rest = match[3] ?? ''
    return { key: `${match[1]!.toLowerCase()}#${Number(match[2])}`, bare: rest === '' || rest === '/' }
  }
  return null
}

type Known = { pr: PullRequest; list: 'mine' | 'review' }
type Run = { key: string; session: CursorSession; pr: PullRequest }
type Step = { id: string; title: string; last?: boolean }

function indexPrs(data: Snapshot | null): Map<string, Known> {
  const known = new Map<string, Known>()
  for (const [list, prs] of [['mine', data?.pullRequests ?? []], ['review', data?.reviewPullRequests ?? []]] as const) {
    for (const pr of prs) {
      const key = `${pr.repo.toLowerCase()}#${pr.number}`
      if (!known.has(key)) known.set(key, { pr, list })
    }
  }
  return known
}

export function runKey(session: CursorSession): string {
  return `${session.agentId}:${session.runId}`
}

function collectRuns(known: Map<string, Known>): Run[] {
  const runs = new Map<string, Run>()
  for (const { pr } of known.values()) {
    for (const session of pr.cursorSessions ?? []) {
      const key = runKey(session)
      if (!runs.has(key)) runs.set(key, { key, session, pr })
    }
  }
  return [...runs.values()]
}

function isUnread(run: Run, state: AgentState): boolean {
  const { status, updatedAt } = run.session
  if (status !== 'finished' && status !== 'failed') return false
  if (updatedAt <= state.since) return false
  const seen = state.seen[run.key]
  return !seen || seen < updatedAt
}

function agentLabel(session: CursorSession): string {
  const first = session.prompt?.split('\n')[0]?.trim()
  if (session.kind === 'prompt' && first) return first
  if (session.kind === 'thread' && first) return first.split('/').at(-1)!
  return agentKindLabel(session.kind)
}

export function ageLabel(from: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (60 * 24))}d`
}

function agentOf(url: string, runs: Run[]): Run | null {
  if (!/^https:\/\/(www\.)?cursor\.com\//.test(url)) return null
  // Newest run first, so a tab on an agent with several runs counts as the latest.
  return runs.filter((run) => url.includes(run.session.agentId)).sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt))[0] ?? null
}

/** Every unread run a tab on this address is showing. */
export function runsShownAt(url: string, data: Snapshot | null, state: AgentState): string[] {
  const runs = collectRuns(indexPrs(data))
  const shown = agentOf(url, runs)
  if (!shown) return []
  return runs.filter((run) => run.session.agentId === shown.session.agentId && isUnread(run, state)).map((run) => run.key)
}

export function unreadRuns(data: Snapshot | null, state: AgentState): string[] {
  return collectRuns(indexPrs(data)).filter((run) => isUnread(run, state) && !state.dismissed.includes(run.key)).map((run) => run.key)
}

/** Drops what is remembered about runs the snapshot no longer has. */
export function pruneAgentState(state: AgentState, data: Snapshot): AgentState {
  const keys = new Set(collectRuns(indexPrs(data)).map((run) => run.key))
  return {
    since: state.since,
    seen: Object.fromEntries(Object.entries(state.seen).filter(([key]) => keys.has(key))),
    dismissed: state.dismissed.filter((key) => keys.has(key)),
  }
}

function needs({ pr, list }: Known): number {
  if (list === 'review') return (pr.unreadCount ?? 0) + (pr.reviewCommentAwaitingCount ?? 0)
  return (pr.awaitingYouCount ?? 0) + (pr.commentAwaitingCount ?? 0)
}

function prTitle(pr: PullRequest): string {
  return `#${pr.number} ${pr.title}`
}

function issueTitle(issue: { identifier: string; title: string | null }): string {
  return issue.title ? `${issue.identifier} · ${issue.title}` : issue.identifier
}

function stackSteps(data: Snapshot | null): Map<string, Step> {
  const steps = new Map<string, Step>()
  for (const prs of [data?.pullRequests ?? [], data?.reviewPullRequests ?? []]) {
    for (const stack of buildStacks(prs)) {
      const bottom = stack.prs.at(-1)
      if (stack.prs.length < 2 || !bottom) continue
      for (const pr of stack.prs) if (!steps.has(pr.key)) steps.set(pr.key, { id: `stack:${stack.id}`, title: bottom.title })
    }
  }
  return steps
}

function pathOf(
  { pr, list }: Known,
  grouping: Exclude<Grouping, 'none'>,
  prefs: DashboardPrefs,
  initiatives: Map<string, string>,
  stacks: Map<string, Step>,
): Step[] {
  const project = pr.linearIssues.find((issue) => issue.projectName)
  const issue = pr.linearIssues[0]
  const initiative = pr.initiativeIds.find((id) => initiatives.has(id))
  const projectStep: Step | null = project ? { id: `project:${project.projectName}`, title: project.projectName! } : null
  const initiativeStep: Step | null = initiative ? { id: `initiative:${initiative}`, title: initiatives.get(initiative)! } : null

  switch (grouping) {
    case 'project':
      return [projectStep ?? { id: 'project:none', title: 'No project', last: true }]
    case 'issue':
      return [issue ? { id: `issue:${issue.identifier}`, title: issueTitle(issue) } : { id: 'issue:none', title: 'No issue', last: true }]
    case 'initiative':
      return [initiativeStep ?? { id: 'initiative:none', title: 'Untagged', last: true }]
    case 'stack':
      return [stacks.get(pr.key) ?? { id: 'stack:none', title: 'Not stacked', last: true }]
    case 'match': {
      // The dashboard's order: a project first, then an initiative, then a bare issue.
      const byIssue = list === 'review' ? prefs.reviewByIssue : prefs.mineByIssue
      if (projectStep) return byIssue ? [projectStep, { id: `${projectStep.id}:${project!.identifier}`, title: issueTitle(project!) }] : [projectStep]
      if (initiativeStep) return [initiativeStep]
      if (byIssue && issue) return [{ id: `issue:${issue.identifier}`, title: issueTitle(issue) }]
      return [{ id: 'match:none', title: 'Ungrouped', last: true }]
    }
  }
}

type Branch = { step: Step; rows: TabInfo[]; subs: Map<string, { step: Step; rows: TabInfo[] }> }

export function buildSidebar(input: {
  tabs: TabInfo[]
  activeId: number
  data: Snapshot | null
  grouping: Grouping
  prefs: DashboardPrefs
  collapsed: string[]
  agentState: AgentState
  /** Runs read in the tab being looked at. They keep their row until another tab takes over. */
  held?: string[]
  now: number
}): SidebarModel {
  const { tabs, activeId, data, grouping, prefs, agentState, now } = input
  const held = new Set(input.held ?? [])
  const known = indexPrs(data)
  const runs = collectRuns(known)
  const lookup = (url: string): Known | null => {
    const ref = prRef(url)
    return ref ? (known.get(ref.key) ?? null) : null
  }

  // Agents.
  const tabOfRun = new Map<string, number>()
  const runOfTab = new Map<number, Run>()
  for (const tab of tabs) {
    if (tab.pinned) continue
    const run = agentOf(tab.url, runs)
    if (!run) continue
    runOfTab.set(tab.id, run)
    for (const other of runs) if (other.session.agentId === run.session.agentId && !tabOfRun.has(other.key)) tabOfRun.set(other.key, tab.id)
  }
  const markOf = (run: Run): AgentMark => {
    if (cursorSessionActive(run.session.status)) return 'running'
    if (!isUnread(run, agentState)) return 'read'
    return run.session.status === 'failed' ? 'failed' : 'unread'
  }
  const agentRow = (run: Run): AgentRow => {
    const mark = markOf(run)
    return {
      key: run.key,
      label: agentLabel(run.session),
      number: run.pr.number,
      mark,
      age: ageLabel(mark === 'running' ? run.session.createdAt : run.session.updatedAt, now),
      url: cursorLinks(run.session.agentId).webUrl,
      tabId: tabOfRun.get(run.key) ?? null,
    }
  }
  const dismissed = new Set(agentState.dismissed)
  const rows = runs.map(agentRow)
  const stamp = new Map(runs.map((run) => [run.key, cursorSessionActive(run.session.status) ? run.session.createdAt : run.session.updatedAt]))
  const newest = (a: AgentRow, b: AgentRow) => stamp.get(b.key)!.localeCompare(stamp.get(a.key)!)
  const listed = (row: AgentRow) => (row.mark !== 'read' || held.has(row.key)) && !dismissed.has(row.key)
  const current = rows.filter(listed)
  const agents = [...current.filter((row) => row.mark === 'running').sort(newest), ...current.filter((row) => row.mark !== 'running').sort(newest)]
  const earlier = rows.filter((row) => !listed(row)).sort(newest)

  // Tabs.
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const plain = tabs.filter((tab) => !tab.pinned && !runOfTab.has(tab.id))
  const children = new Map<number, TabInfo[]>()
  const top: TabInfo[] = []
  for (const tab of plain) {
    const parent = tab.parent === null ? null : byId.get(tab.parent)
    const nests = !lookup(tab.placedUrl) && parent && !parent.pinned && !runOfTab.has(parent.id) && lookup(parent.placedUrl)
    if (nests) children.set(parent.id, [...(children.get(parent.id) ?? []), tab])
    else top.push(tab)
  }

  const activeRuns = new Set(runs.filter((run) => cursorSessionActive(run.session.status)).map((run) => run.pr.key))
  const rowOf = (tab: TabInfo): TabRow => {
    const shown = lookup(tab.url)
    return {
      id: tab.id,
      title: shown ? shown.pr.title : tab.title,
      favicon: tab.favicon,
      loading: tab.loading,
      number: shown ? shown.pr.number : null,
      ci: shown ? shown.pr.ci : null,
      needs: shown ? needs(shown) : 0,
      agent: shown ? activeRuns.has(shown.pr.key) : false,
    }
  }

  const nodes: SidebarNode[] = []
  const order: number[] = agents.concat(earlier).flatMap((row) => (row.tabId === null ? [] : [row.tabId]))
  const crumbs = new Map<number, string[]>()
  const push = (tab: TabInfo, depth: number, visible: boolean, path: string[]) => {
    for (const [index, item] of [tab, ...(children.get(tab.id) ?? [])].entries()) {
      if (!order.includes(item.id)) order.push(item.id)
      crumbs.set(item.id, path)
      if (visible) nodes.push({ kind: 'tab', depth: index === 0 ? depth : depth + 1, row: rowOf(item) })
    }
  }

  if (grouping === 'none') {
    for (const tab of top) push(tab, 0, true, [])
  } else {
    const initiatives = new Map((data?.initiatives ?? []).map((initiative) => [initiative.id, initiative.name]))
    const stacks = grouping === 'stack' ? stackSteps(data) : new Map<string, Step>()
    const branches = new Map<string, Branch>()
    const other: TabInfo[] = []
    for (const tab of top) {
      const placed = lookup(tab.placedUrl)
      if (!placed) {
        other.push(tab)
        continue
      }
      const [first, second] = pathOf(placed, grouping, prefs, initiatives, stacks)
      const branch: Branch = branches.get(first!.id) ?? { step: first!, rows: [], subs: new Map() }
      branches.set(first!.id, branch)
      if (!second) branch.rows.push(tab)
      else {
        const sub = branch.subs.get(second.id) ?? { step: second, rows: [] }
        branch.subs.set(second.id, sub)
        sub.rows.push(tab)
      }
    }
    const ordered = [...branches.values()].sort((a, b) => Number(a.step.last ?? false) - Number(b.step.last ?? false))
    for (const branch of ordered) {
      const open = !input.collapsed.includes(branch.step.id)
      const count = branch.rows.length + [...branch.subs.values()].reduce((sum, sub) => sum + sub.rows.length, 0)
      nodes.push({ kind: 'group', id: branch.step.id, title: branch.step.title, count, open })
      for (const tab of branch.rows) push(tab, 1, open, [branch.step.title])
      for (const sub of branch.subs.values()) {
        if (open) nodes.push({ kind: 'issue', title: sub.step.title })
        for (const tab of sub.rows) push(tab, 1, open, [branch.step.title, sub.step.title])
      }
    }
    if (other.length) {
      if (ordered.length) nodes.push({ kind: 'label', title: 'Other' })
      for (const tab of other) push(tab, 0, true, [])
    }
  }

  const strip: StripTab[] = tabs.map((tab) => {
    const run = runOfTab.get(tab.id)
    const shown = tab.pinned || run ? null : lookup(tab.url)
    return {
      id: tab.id,
      pinned: tab.pinned,
      title: run ? agentLabel(run.session) : shown ? prTitle(shown.pr) : tab.title,
      favicon: tab.favicon,
      loading: tab.loading,
      ci: shown ? shown.pr.ci : null,
      agent: run ? markOf(run) : null,
    }
  })

  const active = byId.get(activeId)
  const activeRun = runOfTab.get(activeId)
  const activePr = active && !active.pinned && !activeRun ? lookup(active.url) : null
  const crumb = !active
    ? []
    : active.pinned
      ? [active.title]
      : activeRun
        ? ['Agents', `${agentLabel(activeRun.session)} · #${activeRun.pr.number}`]
        : [...(crumbs.get(activeId) ?? []), activePr ? prTitle(activePr.pr) : active.title]

  return {
    nodes,
    agents,
    earlier,
    running: agents.filter((row) => row.mark === 'running').length,
    unread: agents.filter((row) => row.mark === 'unread' || row.mark === 'failed').length,
    strip,
    order,
    crumb,
  }
}
