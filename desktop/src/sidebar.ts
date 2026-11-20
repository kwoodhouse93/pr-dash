import { agentKindLabel, sessionActive, sessionLinks } from '../../src/shared/agents.ts'
import { layoutRails } from '../../src/shared/rails.ts'
import { buildStacks, type Stack } from '../../src/shared/stacks.ts'
import { DEFAULT_FILTERS, DEFAULT_SORT, type CiLevel, type AgentSession, type PullRequest, type Snapshot, type Sort } from '../../src/shared/types.ts'
import { buildOutline } from '../../src/shared/view.ts'

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
export type DashboardPrefs = {
  mineByIssue: boolean
  reviewByIssue: boolean
  sort?: Sort
  /** The T3 Code the dashboard is paired with, so a T3 Code thread opens in a tab. */
  t3Origin?: string | null
}

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
  /** What the pull request is based on, for the row's tooltip. */
  note?: string
}

export type Line = 'solid' | 'dotted'
export type LaneLine = { lane: number; line: Line }

/** One row's part of a stack's rail. Lane 0 is the leftmost; a branch runs in a lane to its right. */
export type RowRail = {
  /** Lanes the whole stack needs here, so every title in it starts at the same place. */
  lanes: number
  /** The lane the row's status dot sits on. Null on a page nested under a pull request, which lanes only pass. */
  lane: number | null
  /** A stub is a short dotted end: the stack goes on, to pull requests that are not open here. */
  up: Line | 'stub' | null
  down: Line | 'stub' | null
  /** Branches that end at this row. */
  joins: LaneLine[]
  through: LaneLine[]
}

export type SidebarNode =
  | { kind: 'group'; id: string; title: string; count: number; open: boolean }
  | { kind: 'issue'; title: string }
  | { kind: 'label'; title: string }
  | { kind: 'tab'; depth: number; row: TabRow; rail?: RowRail }

export type AgentMark = 'running' | 'unread' | 'failed' | 'read'

export type AgentRow = {
  key: string
  label: string
  number: number
  mark: AgentMark
  age: string
  /** The session's page. Null until the provider gives one. */
  url: string | null
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

export type LinearRef = { issue: string | null; project: string | null }

/** The Linear page an address shows: its issue, or its project's part of the address, when it has one. */
export function linearRef(url: string): LinearRef | null {
  const match = /^https:\/\/linear\.app(?:\/([^?#]*))?/.exec(url)
  if (!match) return null
  const [, kind, name] = (match[1] ?? '').split('/')
  return { issue: kind === 'issue' && name ? name.toUpperCase() : null, project: kind === 'project' && name ? name.toLowerCase() : null }
}

/** Linear only bounces a link to its desktop app when the address lacks this. */
const STAY = 'noRedirect'

/** The address that keeps a Linear page in this window, or null when it already does or is not Linear's. */
export function linearStayUrl(url: string): string | null {
  if (!linearRef(url)) return null
  const next = new URL(url)
  if (next.searchParams.has(STAY)) return null
  next.searchParams.set(STAY, '1')
  return next.href
}

/** A tab's address as it should leave the app, without what was added to keep Linear here. */
export function shareUrl(url: string): string {
  if (!linearRef(url)) return url
  const next = new URL(url)
  if (!next.searchParams.has(STAY)) return url
  next.searchParams.delete(STAY)
  return next.href
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** The project a Linear page belongs to, as far as the pull requests on the dashboard tell. */
function linearProject(ref: LinearRef, known: Map<string, Known>): string | null {
  for (const { pr } of known.values()) {
    for (const issue of pr.linearIssues) {
      if (!issue.projectName) continue
      if (ref.issue === issue.identifier.toUpperCase()) return issue.projectName
      // A project's address is its name and then an id.
      if (ref.project && ref.project.replace(/-[0-9a-f]+$/, '') === slug(issue.projectName)) return issue.projectName
    }
  }
  return null
}

type Known = { pr: PullRequest; list: 'mine' | 'review' }
type Run = { key: string; session: AgentSession; pr: PullRequest }
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

/**
 * A link that belongs to another app on this machine, which the system opens there.
 * Only the apps agents run in: a page cannot use this to launch anything else.
 */
export function isAppLink(url: string): boolean {
  return /^(t3code|cursor):/i.test(url)
}

export function runKey(session: AgentSession): string {
  return `${session.agentId}:${session.runId}`
}

function collectRuns(known: Map<string, Known>): Run[] {
  const runs = new Map<string, Run>()
  for (const { pr } of known.values()) {
    for (const session of pr.agentSessions ?? []) {
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

function agentLabel(session: AgentSession): string {
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
  const cursor = /^https:\/\/(www\.)?cursor\.com\//.test(url)
  // A tab moves around inside its agent's pages, so go by the agent's id in the address.
  // T3 Code writes a thread's id into an address both plainly and escaped.
  const shown = runs.filter((run) =>
    run.session.provider === 'cursor'
      ? cursor && url.includes(run.session.agentId)
      : !cursor && (url.includes(`/${run.session.agentId}`) || url.includes(`/${encodeURIComponent(run.session.agentId)}`)),
  )
  // Newest run first, so a tab on an agent with several runs counts as the latest.
  return shown.sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt))[0] ?? null
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

type Layout = { rank: Map<string, number>; stacks: Map<string, Stack> }
let layoutCache: { data: Snapshot | null; prefs: string; layout: Layout } | null = null

/** Where the dashboard lists each pull request, and the stack each one is in. A pull request on its own has no stack. */
function dashboardLayout(data: Snapshot | null, prefs: DashboardPrefs): Layout {
  const key = JSON.stringify(prefs)
  if (layoutCache && layoutCache.data === data && layoutCache.prefs === key) return layoutCache.layout
  const rank = new Map<string, number>()
  const stacks = new Map<string, Stack>()
  for (const [prs, attention, byIssue] of [
    [data?.pullRequests ?? [], 'author', prefs.mineByIssue],
    [data?.reviewPullRequests ?? [], 'reviewer', prefs.reviewByIssue],
  ] as const) {
    for (const stack of buildStacks(prs)) {
      if (stack.prs.length < 2) continue
      for (const pr of stack.prs) if (!stacks.has(pr.key)) stacks.set(pr.key, stack)
    }
    const outline = buildOutline(prs, data?.initiatives ?? [], DEFAULT_FILTERS, prefs.sort ?? DEFAULT_SORT, attention, byIssue, data?.viewer ?? null)
    const buckets = [...outline.projects.flatMap((project) => project.issues), ...outline.initiatives, ...outline.looseIssues, ...(outline.unassigned ? [outline.unassigned] : [])]
    for (const bucket of buckets) {
      for (const block of [...bucket.stacks, ...bucket.singles]) {
        for (const row of block.rows) {
          for (const pr of row.type === 'pr' ? [row.pr.key] : row.keys) if (!rank.has(pr)) rank.set(pr, rank.size)
        }
      }
    }
  }
  const layout = { rank, stacks }
  layoutCache = { data, prefs: key, layout }
  return layout
}

type Drawn = { rail: RowRail; passing: RowRail; note: string }

/**
 * The rail for a run of rows, top to bottom. Each entry is the pull request the row stands for, or null.
 * Rows of one stack that sit together share a rail; a line is dotted where pull requests between two rows are not open.
 */
export function drawStacks(keys: (string | null)[], stacks: Map<string, Stack>): (Drawn | null)[] {
  const drawn: (Drawn | null)[] = keys.map(() => null)
  let start = 0
  while (start < keys.length) {
    const stack = keys[start] ? stacks.get(keys[start]!) : undefined
    let end = start + 1
    if (!stack) {
      start = end
      continue
    }
    const run = [keys[start]!]
    while (end < keys.length && keys[end] && stacks.get(keys[end]!) === stack && !run.includes(keys[end]!)) run.push(keys[end++]!)

    // What each row is based on among the rows here, and how many pull requests the line to it skips.
    const based = run.map((key, index) => {
      let skipped = 0
      for (let parent = stack.parents[key] ?? null; parent; parent = stack.parents[parent] ?? null) {
        if (run.indexOf(parent) > index) return { parent, skipped }
        skipped += 1
      }
      return null
    })
    const { rails, lanes } = layoutRails(run.map((key, index) => ({ id: key, parent: based[index]?.parent ?? null })))
    const lineOf = (index: number): Line => (based[index]!.skipped > 0 ? 'dotted' : 'solid')
    // The line coming down a lane to a row started at the nearest row above on that lane.
    const arriving = (lane: number, index: number): LaneLine => {
      for (let above = index - 1; above >= 0; above -= 1) if (rails[above]!.lane === lane && rails[above]!.down) return { lane, line: lineOf(above) }
      return { lane, line: 'solid' }
    }
    for (const [index, key] of run.entries()) {
      const rail = rails[index]!
      const parent = stack.parents[key] ?? null
      const through = rail.through.map((lane) => arriving(lane, index))
      const hasChild = Object.values(stack.parents).includes(key)
      const number = (pr: string) => stack.prs.find((item) => item.key === pr)?.number
      drawn[start + index] = {
        rail: {
          lanes,
          lane: rail.lane,
          up: rail.up ? arriving(rail.lane, index).line : hasChild ? 'stub' : null,
          down: rail.down ? lineOf(index) : parent ? 'stub' : null,
          joins: rail.joins.map((lane) => arriving(lane, index)),
          through,
        },
        passing: { lanes, lane: null, up: null, down: null, joins: [], through: rail.down ? [...through, { lane: rail.lane, line: lineOf(index) }] : through },
        note: !parent ? 'Bottom of its stack' : run.includes(parent) ? `Based on #${number(parent)}` : `Based on #${number(parent)}, which is not open here`,
      }
    }
    start = end
  }
  return drawn
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
  /** Linear pages go under their project inside the Linear section. */
  linearByProject?: boolean
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
    if (sessionActive(run.session.status)) return 'running'
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
      url: sessionLinks(run.session, input.prefs.t3Origin).webUrl,
      tabId: tabOfRun.get(run.key) ?? null,
    }
  }
  const dismissed = new Set(agentState.dismissed)
  const rows = runs.map(agentRow)
  const stamp = new Map(runs.map((run) => [run.key, sessionActive(run.session.status) ? run.session.createdAt : run.session.updatedAt]))
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
    const nests = !lookup(tab.placedUrl) && !linearRef(tab.placedUrl) && parent && !parent.pinned && !runOfTab.has(parent.id) && lookup(parent.placedUrl)
    if (nests) children.set(parent.id, [...(children.get(parent.id) ?? []), tab])
    else top.push(tab)
  }

  const activeRuns = new Set(runs.filter((run) => sessionActive(run.session.status)).map((run) => run.pr.key))
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
  const push = (tab: TabInfo, depth: number, visible: boolean, path: string[], drawn?: Drawn) => {
    for (const [index, item] of [tab, ...(children.get(tab.id) ?? [])].entries()) {
      if (!order.includes(item.id)) order.push(item.id)
      crumbs.set(item.id, path)
      if (!visible) continue
      const row = rowOf(item)
      if (!drawn) nodes.push({ kind: 'tab', depth: index === 0 ? depth : depth + 1, row })
      else if (index === 0) nodes.push({ kind: 'tab', depth, row: { ...row, note: drawn.note }, rail: drawn.rail })
      else nodes.push({ kind: 'tab', depth, row, rail: drawn.passing })
    }
  }

  if (grouping === 'none') {
    for (const tab of top) push(tab, 0, true, [])
  } else {
    const { rank, stacks } = dashboardLayout(data, prefs)
    const rankOf = (tab: TabInfo) => rank.get(lookup(tab.placedUrl)?.pr.key ?? '') ?? Number.MAX_SAFE_INTEGER
    const sorted = (rows: TabInfo[]) => rows.slice().sort((a, b) => rankOf(a) - rankOf(b))
    const first = (rows: TabInfo[]) => Math.min(Number.MAX_SAFE_INTEGER, ...rows.map(rankOf))
    // The pull request a row stands for in its stack. A tab that has left its pull request is not part of one.
    const stackKey = (tab: TabInfo) => {
      const placed = lookup(tab.placedUrl)?.pr.key
      return placed && placed === lookup(tab.url)?.pr.key && stacks.has(placed) ? placed : null
    }
    const pushAll = (rows: TabInfo[], visible: boolean, path: string[]) => {
      const list = sorted(rows)
      const drawn = drawStacks(list.map(stackKey), stacks)
      for (const [index, tab] of list.entries()) push(tab, 1, visible, path, drawn[index] ?? undefined)
    }

    const initiatives = new Map((data?.initiatives ?? []).map((initiative) => [initiative.id, initiative.name]))
    const steps = new Map<string, Step>()
    if (grouping === 'stack') {
      for (const [key, stack] of stacks) steps.set(key, { id: `stack:${stack.id}`, title: stack.prs.at(-1)!.title })
    }
    const branches = new Map<string, Branch>()
    const linear: TabInfo[] = []
    const other: TabInfo[] = []
    for (const tab of top) {
      const placed = lookup(tab.placedUrl)
      if (!placed) {
        ;(linearRef(tab.placedUrl) ? linear : other).push(tab)
        continue
      }
      const [head, second] = pathOf(placed, grouping, prefs, initiatives, steps)
      const branch: Branch = branches.get(head!.id) ?? { step: head!, rows: [], subs: new Map() }
      branches.set(head!.id, branch)
      if (!second) branch.rows.push(tab)
      else {
        const sub = branch.subs.get(second.id) ?? { step: second, rows: [] }
        branch.subs.set(second.id, sub)
        sub.rows.push(tab)
      }
    }
    // Groups, and the pull requests in them, come in the dashboard's order.
    const all = (branch: Branch) => [...branch.rows, ...[...branch.subs.values()].flatMap((sub) => sub.rows)]
    const ordered = [...branches.values()].sort((a, b) => Number(a.step.last ?? false) - Number(b.step.last ?? false) || first(all(a)) - first(all(b)))
    for (const branch of ordered) {
      const open = !input.collapsed.includes(branch.step.id)
      nodes.push({ kind: 'group', id: branch.step.id, title: branch.step.title, count: all(branch).length, open })
      pushAll(branch.rows, open, [branch.step.title])
      for (const sub of [...branch.subs.values()].sort((a, b) => first(a.rows) - first(b.rows))) {
        if (open) nodes.push({ kind: 'issue', title: sub.step.title })
        pushAll(sub.rows, open, [branch.step.title, sub.step.title])
      }
    }
    if (linear.length) {
      nodes.push({ kind: 'label', title: 'Linear' })
      if (!input.linearByProject) for (const tab of linear) push(tab, 0, true, ['Linear'])
      else {
        const projects = new Map<string, TabInfo[]>()
        for (const tab of linear) {
          const name = linearProject(linearRef(tab.placedUrl)!, known) ?? ''
          projects.set(name, [...(projects.get(name) ?? []), tab])
        }
        // Projects in the order their first tab was opened, and pages with no known project last.
        for (const [name, rows] of [...projects].sort(([a], [b]) => Number(a === '') - Number(b === ''))) {
          const id = name ? `linear:project:${name}` : 'linear:none'
          const title = name || 'No project'
          const open = !input.collapsed.includes(id)
          nodes.push({ kind: 'group', id, title, count: rows.length, open })
          for (const tab of rows) push(tab, 1, open, ['Linear', title])
        }
      }
    }
    if (other.length) {
      if (ordered.length || linear.length) nodes.push({ kind: 'label', title: 'Other' })
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
