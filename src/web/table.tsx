import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { activeHoldNames, checkPhase, checkStamp, ciDetail, ciLabel, compareChecks, displayCi, selectChecks, worstDisplay, type CheckHold, type CiDisplay } from '../shared/ci.ts'
import {
  activeSession,
  agentKindLabel,
  agentWork,
  failingChecks,
  leadingStatus,
  PROMPT_LIMIT,
  providerLabel,
  sessionActive,
  sessionStatusLabel,
  type AgentRequest,
} from '../shared/agents.ts'
import { approvedByLogin } from '../shared/approval.ts'
import { canMergeSlice, canSquashMerge, sliceParts } from '../shared/merge.ts'
import { stepLabel, type MergeWatch, type RowMark, type StepStatus } from '../shared/queue.ts'
import type { Rail } from '../shared/rails.ts'
import { downstackKeys, mergeLineKeys, upstackKeys, type Parents, type StackSummary } from '../shared/stacks.ts'
import { rollup, SEGMENT_LABEL, segmentState, type SegmentState } from '../shared/segments.ts'
import { RepoIcon } from './repo-mark.tsx'
import type { AgentRouting, AgentSession, Check, Initiative, LinearIssue, MergeMark, PullRequest, Sort, SortKey } from '../shared/types.ts'
import { blockRails, type Bucket, type Outline, type ProjectGroup, type StackBlock } from '../shared/view.ts'
import { AgentDrawer, AgentList } from './agents.tsx'
import { AgentProvider, launchTag, useAgentLaunch, useAgentName, useSessionLinks, type StartAgent } from './agent-launch.tsx'
import { TagEditor } from './editors.tsx'
import { ageFill, ageHeat, cobwebTier, copyPrIdsLabel, formatAgo, formatCount, formatExact, formatWhen, graphitePrUrl, prCopyId, prCopyList } from './format.ts'
import { useChanged, useSlidingRows } from './motion.tsx'
import { usePrHref } from './pr-links.tsx'
import { isLinearIdentifier, IssueControls, LinkIssueForm } from './issue-controls.tsx'
import type { FeedbackCounts } from '../shared/feedback.ts'
import { Feedback, FeedbackProvider, feedbackTarget, useViewer } from './feedback.tsx'
import { ClickCard, HoverCard, useMenuClose } from './menus.tsx'
import { reviewChase, type ChaseMessage } from './chase.ts'
import { toastError, toastSuccess } from './toasts.tsx'

type StackLock = {
  locked: boolean
  lock: () => boolean
  unlock: () => void
}

const StackLockContext = createContext<StackLock>({
  locked: false,
  lock: () => false,
  unlock: () => {},
})

function useStackLock(): StackLock {
  return useContext(StackLockContext)
}

const COLUMNS = 17

const HoldContext = createContext<Map<string, CheckHold[]>>(new Map())
const EMPTY_HOLDS: CheckHold[] = []

/** Pull requests whose state just changed, and the ones that just merged and are on their way off the list. */
const MotionContext = createContext<{ changed: Map<string, number>; leaving: Set<string> }>({ changed: new Map(), leaving: new Set() })

/** What a row shows of a pull request's state. When this changes, the row is washed warm for a moment. */
function rowSignature(pr: PullRequest): string {
  return [pr.ci, pr.awaitingYouCount, pr.commentAwaitingCount, pr.unreadCount, pr.resolvedUnreadCount, pr.reviewCommentAwaitingCount, pr.reviewDecision, pr.mergeMark, pr.conflict, pr.isDraft].join('|')
}

/** The classes for a row that changed or is leaving. A second change swaps to a twin animation so the wash starts again. */
function motionClass(keys: string[], motion: { changed: Map<string, number>; leaving: Set<string> }): string {
  if (keys.length > 0 && keys.every((key) => motion.leaving.has(key))) return ' landing'
  const stamp = Math.max(0, ...keys.map((key) => motion.changed.get(key) ?? 0))
  return stamp === 0 ? '' : stamp % 2 === 1 ? ' fresh-a' : ' fresh-b'
}

function useHolds(): Map<string, CheckHold[]> {
  return useContext(HoldContext)
}

function shownLevel(prs: PullRequest[], holds: Map<string, CheckHold[]>): CiDisplay {
  return worstDisplay(prs.map((pr) => displayCi(pr.checks, activeHoldNames(pr.checks, holds.get(pr.key) ?? EMPTY_HOLDS))))
}

export function PrTable({
  mode,
  outline,
  sort,
  initiatives,
  prByKey,
  showRepo,
  expanded,
  collapsed,
  onSort,
  onToggle,
  onToggleSection,
  onAssign,
  onCreateAssigned,
  onMerge,
  onRetry,
  onStackMerge,
  onMarkReady,
  onSetMergeWhenReady,
  queueByKey,
  watchesByKey,
  holds,
  onRerun,
  onStartAgent,
  agentRouting,
  t3Origin,
  onRebase,
  byIssue,
  onRefreshPr,
  linearConfigured,
  onUpdateIssue,
  onLinkIssue,
  viewer,
  onFeedback,
  leaving = NONE_LEAVING,
}: {
  mode: 'mine' | 'review'
  outline: Outline
  sort: Sort
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  /** False when every pull request in the list is in one repository, so the column would say the same thing on each row. */
  showRepo: boolean
  expanded: Set<string>
  collapsed: Set<string>
  onSort: (key: SortKey) => void
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
  queueByKey: Map<string, RowMark>
  watchesByKey: Map<string, MergeWatch>
  holds: Map<string, CheckHold[]>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onStartAgent: StartAgent
  /** Which provider starts agents for each repository. Left out, Cursor starts them all. */
  agentRouting?: AgentRouting
  /** The T3 Code this browser is paired with, so its threads open in a tab. */
  t3Origin?: string | null
  onRebase: (key: string) => Promise<void>
  byIssue: boolean
  onRefreshPr: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
  viewer: string | null
  onFeedback: (key: string, counts: FeedbackCounts) => void
  /** Pull requests that merged a moment ago and are still listed while their row plays out. */
  leaving?: Set<string>
}) {
  const body = useRef<HTMLTableSectionElement>(null)
  useSlidingRows(body)
  const signatures = useMemo(() => new Map([...prByKey].map(([key, pr]) => [key, rowSignature(pr)])), [prByKey])
  const changed = useChanged(signatures)
  const motion = useMemo(() => ({ changed, leaving }), [changed, leaving])
  const tones = stackTones(outline)
  const lanes = useMemo(() => widestRail(outline), [outline])
  const shared = {
    mode,
    namesList: initiatives,
    prByKey,
    showRepo,
    tones,
    expanded,
    collapsed,
    onToggle,
    onToggleSection,
    onAssign,
    onCreateAssigned,
    onMerge,
    onRetry,
    onStackMerge,
    onMarkReady,
    onSetMergeWhenReady,
    queueByKey,
    watchesByKey,
    onRerun,
    onRebase,
    onRefreshPr,
    linearConfigured,
    onUpdateIssue,
    onLinkIssue,
  }
  return (
    <FeedbackProvider viewer={viewer} onCounts={onFeedback}>
    <AgentProvider start={onStartAgent} routing={agentRouting} t3Origin={t3Origin}>
    <HoldContext.Provider value={holds}>
    <MotionContext.Provider value={motion}>
    <table className="prs" style={{ '--lanes': lanes } as CSSProperties}>
      <thead>
        <tr>
          <th className="grip" aria-label="Stack" />
          <th className="num">#</th>
          <SortHeader label="Title" sortKey="title" sort={sort} onSort={onSort} />
          {mode === 'review' ? <th className="author">Author</th> : null}
          {showRepo ? <SortHeader className="repo" label="Repo" sortKey="repo" sort={sort} onSort={onSort} /> : null}
          <SortHeader className="size" colSpan={3} label="Size" sortKey="size" sort={sort} onSort={onSort} />
          <SortHeader className="when" label="Age" title="Time since it was ready for review, as a ring that fills over two days. Hover one for the time. A draft shows the time since it was opened." sortKey="created" sort={sort} onSort={onSort} />
          <SortHeader className="when" label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
          <SortHeader label="CI" sortKey="ci" sort={sort} onSort={onSort} />
          <th className="branch" title="A red cross is a merge conflict. A white cross is behind the base branch.">Branch</th>
          <th>Review</th>
          <th>Feedback</th>
          <th className="agents" title="Agents started from this dashboard">
            <span className="sr">Agents</span>
            <RobotIcon />
          </th>
          {mode === 'mine' ? <th className="merge">Merge</th> : null}
          <th className="open">Open</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody ref={body}>
        {outline.projects.length ? (
          <SectionBand id="band:projects" title="Linear projects" collapsed={collapsed} onToggle={onToggleSection}>
            {outline.projects.map((project) => (
              <ProjectRows key={project.id} project={project} {...shared} />
            ))}
          </SectionBand>
        ) : null}
        {outline.initiatives.length ? (
          <SectionBand id="band:initiatives" title="Initiatives" collapsed={collapsed} onToggle={onToggleSection}>
            {outline.initiatives.map((bucket) => (
              <BucketRows key={bucket.id} bucket={bucket} depth={1} {...shared} />
            ))}
          </SectionBand>
        ) : null}
        {outline.looseIssues.length ? (
          <SectionBand id="band:loose" title="Issues with no project" collapsed={collapsed} onToggle={onToggleSection}>
            {outline.looseIssues.map((bucket) => (
              <BucketRows key={bucket.id} bucket={bucket} depth={1} {...shared} />
            ))}
          </SectionBand>
        ) : null}
        {outline.unassigned ? (
          byIssue || outline.projects.length > 0 || outline.initiatives.length > 0 ? (
            <SectionBand id="band:unassigned" title="No issue" collapsed={collapsed} onToggle={onToggleSection}>
              <BucketRows bucket={outline.unassigned} depth={1} untitled {...shared} />
            </SectionBand>
          ) : (
            <BucketRows bucket={outline.unassigned} depth={1} untitled {...shared} />
          )
        ) : null}
      </tbody>
    </table>
    </MotionContext.Provider>
    </HoldContext.Provider>
    </AgentProvider>
    </FeedbackProvider>
  )
}

const NONE_LEAVING: Set<string> = new Set()
const SKELETON_TITLES = [62, 44, 71, 38, 56, 49, 66, 41]

/** The list while it loads: the table's own columns, with a bar where each value will be. */
export function SkeletonTable({ mode, note }: { mode: 'mine' | 'review'; note: string }) {
  const bar = (width: number, height?: number, extra = '') => <span className={`sk${extra}`} style={{ width, height }} />
  return (
    <div role="status">
      <span className="sr">{note}</span>
      <table className="prs skeleton" aria-hidden="true">
        <thead>
          <tr>
            <th className="grip" />
            <th className="num">#</th>
            <th>Title</th>
            {mode === 'review' ? <th className="author">Author</th> : null}
            <th className="size" colSpan={3}>Size</th>
            <th className="when">Age</th>
            <th className="when">Updated</th>
            <th>CI</th>
            <th className="branch">Branch</th>
            <th>Review</th>
            <th>Feedback</th>
            <th className="agents"><RobotIcon /></th>
            {mode === 'mine' ? <th className="merge">Merge</th> : null}
            <th className="open">Open</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr className="band">
            <td colSpan={COLUMNS}>{bar(150, 14)}</td>
          </tr>
          {SKELETON_TITLES.map((title, index) => (
            <tr key={title} style={{ '--i': index } as CSSProperties}>
              <td className="grip" />
              <td className="num">{bar(34)}</td>
              <td className="title-block">
                <span className="sk block" style={{ width: `${title}%` }} />
                {index % 3 === 1 ? null : <span className="sk block" style={{ width: 96 }} />}
              </td>
              {mode === 'review' ? <td className="author">{bar(22, 22, ' round')}</td> : null}
              <td className="size add">{bar(24)}</td>
              <td className="size del">{bar(20)}</td>
              <td className="size files">{bar(18)}</td>
              <td className="when age">{bar(16, 16, ' round')}</td>
              <td className="when">{bar(22)}</td>
              <td>{bar(56, 18, ' round')}</td>
              <td className="uptodate" />
              <td>{bar(16, 16, ' square')}{bar(16, 16, ' square')}{bar(16, 16, ' square')}</td>
              <td>{bar(26)}</td>
              <td className="agents" />
              {mode === 'mine' ? <td className="merge">{index % 3 === 0 ? bar(64, 26, ' amber') : null}</td> : null}
              <td className="open">{bar(16, 16, ' square')}{bar(16, 16, ' square')}</td>
              <td className="row-actions" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  colSpan,
  title,
}: {
  label: string
  sortKey: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  className?: string
  colSpan?: number
  title?: string
}) {
  const active = sort.key === sortKey
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th className={className} colSpan={colSpan} title={title}>
      <button type="button" className="sort" aria-pressed={active} onClick={() => onSort(sortKey)}>
        {label}
        {arrow}
      </button>
    </th>
  )
}

type Spine = 'start' | 'mid' | 'end' | 'only'

function spineClass(spine: Spine | null, tone: 'a' | 'b' | null): string {
  if (!spine) return ''
  return ` spine-${spine}${tone ? ` tone-${tone}` : ''}`
}

type RowShared = {
  mode: 'mine' | 'review'
  namesList: Initiative[]
  prByKey: Map<string, PullRequest>
  showRepo: boolean
  tones: Map<string, 'a' | 'b'>
  expanded: Set<string>
  collapsed: Set<string>
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
  queueByKey: Map<string, RowMark>
  watchesByKey: Map<string, MergeWatch>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onRebase: (key: string) => Promise<void>
  onRefreshPr: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
}

function SectionBand({
  id,
  title,
  collapsed,
  onToggle,
  children,
}: {
  id: string
  title: string
  collapsed: Set<string>
  onToggle: (id: string) => void
  children: ReactNode
}) {
  const open = !collapsed.has(id)
  return (
    <>
      <tr className="band fold" data-flip={id} onClick={(event) => toggleSection(event, () => onToggle(id))}>
        <td colSpan={COLUMNS}>
          <SectionHead open={open} label={title} onToggle={() => onToggle(id)}>
            <span className="section-title">{title}</span>
          </SectionHead>
        </td>
      </tr>
      {open ? children : null}
    </>
  )
}

function ProjectRows({ project, ...shared }: { project: ProjectGroup } & RowShared) {
  const count = project.issues.reduce((total, issue) => total + issue.count, 0)
  const open = !shared.collapsed.has(project.id)
  return (
    <>
      <tr className="project depth-1 fold" data-flip={project.id} onClick={(event) => toggleSection(event, () => shared.onToggleSection(project.id))}>
        <td colSpan={COLUMNS}>
          <SectionHead open={open} label={project.title} onToggle={() => shared.onToggleSection(project.id)}>
            <span className="section-title">{project.title}</span>
            <span className="section-meta">{count === 1 ? '1 pull request' : `${count} pull requests`}</span>
            <SectionRollup buckets={project.issues} prByKey={shared.prByKey} mode={shared.mode} />
          </SectionHead>
        </td>
      </tr>
      {open
        ? project.issues.map((bucket) => <BucketRows key={bucket.id} bucket={bucket} depth={2} {...shared} />)
        : null}
    </>
  )
}

function BucketRows({ bucket, depth, untitled = false, ...shared }: { bucket: Bucket; depth: number; untitled?: boolean } & RowShared) {
  const collapsible = Boolean(bucket.title) && !untitled
  const open = !collapsible || !shared.collapsed.has(bucket.id)
  return (
    <>
      {collapsible ? (
        <tr className={`section depth-${depth} fold`} data-flip={`${depth}:${bucket.id}`} onClick={(event) => toggleSection(event, () => shared.onToggleSection(bucket.id))}>
          <td colSpan={COLUMNS}>
            <SectionHead open={open} label={bucket.title!} onToggle={() => shared.onToggleSection(bucket.id)}>
              {shared.linearConfigured ? <SectionIssue bucket={bucket} onUpdateIssue={shared.onUpdateIssue} /> : null}
              {bucket.href ? (
                <a className="section-title" href={bucket.href} target="_blank" rel="noreferrer">
                  {bucket.title}
                </a>
              ) : (
                <span className="section-title">{bucket.title}</span>
              )}
              {bucket.meta ? <span className="section-meta">{bucket.meta}</span> : null}
              <SectionRollup buckets={[bucket]} prByKey={shared.prByKey} mode={shared.mode} />
            </SectionHead>
          </td>
        </tr>
      ) : null}
      {open ? (
        <>
          {bucket.stacks.map((block) => (
            <BlockRows key={block.id} bucket={bucket} block={block} tone={shared.tones.get(`${bucket.id}:${block.id}`) ?? 'a'} {...shared} />
          ))}
          {bucket.singles.map((block) => (
            <BlockRows key={block.id} bucket={bucket} block={block} tone={null} {...shared} />
          ))}
        </>
      ) : null}
    </>
  )
}

function pressedControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, label, .drawer-back, .popover'))
}

function toggleSection(event: { target: EventTarget | null }, toggle: () => void) {
  if (pressedControl(event.target)) return
  toggle()
}

function SectionHead({
  open,
  label,
  onToggle,
  children,
}: {
  open: boolean
  label: string
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="section-head">
      <div className="section-line">{children}</div>
      <button
        type="button"
        className="section-toggle"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}

function stackTones(outline: Outline): Map<string, 'a' | 'b'> {
  const tones = new Map<string, 'a' | 'b'>()
  let index = 0
  const take = (bucket: Bucket) => {
    for (const block of bucket.stacks) {
      tones.set(`${bucket.id}:${block.id}`, index % 2 === 0 ? 'a' : 'b')
      index += 1
    }
  }
  for (const project of outline.projects) for (const issue of project.issues) take(issue)
  for (const bucket of outline.initiatives) take(bucket)
  for (const bucket of outline.looseIssues) take(bucket)
  if (outline.unassigned) take(outline.unassigned)
  return tones
}

/** The most lanes any stack needs, so the rail column is wide enough for the widest one. */
function widestRail(outline: Outline): number {
  let lanes = 1
  const take = (bucket: Bucket) => {
    for (const block of bucket.stacks) lanes = Math.max(lanes, blockRails(block).lanes)
  }
  for (const project of outline.projects) for (const issue of project.issues) take(issue)
  for (const bucket of outline.initiatives) take(bucket)
  for (const bucket of outline.looseIssues) take(bucket)
  if (outline.unassigned) take(outline.unassigned)
  return lanes
}

function spineAt(index: number, total: number): Spine {
  if (total <= 1) return 'only'
  if (index === 0) return 'start'
  if (index === total - 1) return 'end'
  return 'mid'
}

function BlockRows({
  bucket,
  block,
  tone,
  ...shared
}: { bucket: Bucket; block: StackBlock; tone: 'a' | 'b' | null } & RowShared) {
  const openId = `${bucket.id}:${block.id}`
  const open = shared.expanded.has(openId)
  const lockRef = useRef(false)
  const [locked, setLocked] = useState(false)
  const stackLock: StackLock = {
    locked,
    lock: () => {
      if (lockRef.current) return false
      lockRef.current = true
      setLocked(true)
      return true
    },
    unlock: () => {
      lockRef.current = false
      setLocked(false)
    },
  }
  // For a moment after a stack is opened, its rows play their way in.
  const [unfolding, setUnfolding] = useState(false)
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    if (open === wasOpen.current) return
    wasOpen.current = open
    if (!open || !block.collapsible) return
    setUnfolding(true)
    const timer = window.setTimeout(() => setUnfolding(false), 600 + block.rows.length * 45)
    return () => window.clearTimeout(timer)
  }, [open])
  const unfoldAt = (index: number) => (unfolding ? Math.min(index, 14) : null)
  const visible = block.rows.flatMap((row) => (row.type === 'pr' ? [row.pr] : []))
  const stackTone = block.collapsible ? tone : null
  const layout = useMemo(() => blockRails(block), [block])
  // A stack with branches draws a lane for each one. A straight stack keeps the single spine.
  const forked = stackTone != null && layout.lanes > 1
  const rows =
    !block.collapsible || open ? (
      block.rows.map((row, index) => {
      const spine = stackTone ? spineAt(index, block.rows.length) : null
      const rail = forked ? (layout.rails[index] ?? null) : null
      return row.type === 'ellipsis' ? (
        <tr key={row.id} className={`ellipsis${rail ? ' forked' : ''}${spineClass(spine, stackTone)}${unfoldClass(unfoldAt(index))}`} style={unfoldStyle(unfoldAt(index))} data-flip={`${bucket.id}:${row.id}`}>
          <Grip spine={spine} rail={rail} hollow />
          <td />
          <td colSpan={COLUMNS - 2}>
            … {row.count} pull request{row.count === 1 ? '' : 's'} {row.place} · {row.reason}
          </td>
        </tr>
      ) : (
        <DataRow
          key={row.pr.id}
          mode={shared.mode}
          pr={row.pr}
          flip={`${bucket.id}:${row.pr.key}`}
          unfold={unfoldAt(index)}
          block={block}
          child={block.collapsible}
          spine={spine}
          rail={rail}
          tone={stackTone}
          toggle={block.collapsible && row.pr.id === visible[0]?.id ? { id: openId, open, onToggle: shared.onToggle } : null}
          hideIssue={bucket.issueId ?? undefined}
          initiatives={shared.namesList}
          prByKey={shared.prByKey}
          showRepo={shared.showRepo}
          linearConfigured={shared.linearConfigured}
          onAssign={shared.onAssign}
          onCreateAssigned={shared.onCreateAssigned}
          onMerge={shared.onMerge}
          onRetry={shared.onRetry}
          onStackMerge={shared.onStackMerge}
          onMarkReady={shared.onMarkReady}
          onSetMergeWhenReady={shared.onSetMergeWhenReady}
          queueByKey={shared.queueByKey}
          watchesByKey={shared.watchesByKey}
          onRerun={shared.onRerun}
          onRebase={shared.onRebase}
          onRefreshPr={shared.onRefreshPr}
          onUpdateIssue={shared.onUpdateIssue}
          onLinkIssue={shared.onLinkIssue}
        />
      )
    })
  ) : (
    <SummaryRow
      key={block.id}
      mode={shared.mode}
      block={block}
      visible={visible}
      flip={`${bucket.id}:${block.summary.topKey}`}
      openId={openId}
      spine="only"
      tone={stackTone}
      hideIssue={bucket.issueId ?? undefined}
      initiatives={shared.namesList}
      prByKey={shared.prByKey}
      showRepo={shared.showRepo}
      linearConfigured={shared.linearConfigured}
      onToggle={shared.onToggle}
      onAssign={shared.onAssign}
      onCreateAssigned={shared.onCreateAssigned}
      onRerun={shared.onRerun}
      onRebase={shared.onRebase}
      onRefreshPr={shared.onRefreshPr}
      onUpdateIssue={shared.onUpdateIssue}
      onLinkIssue={shared.onLinkIssue}
      onMerge={shared.onMerge}
      onRetry={shared.onRetry}
      onStackMerge={shared.onStackMerge}
      onMarkReady={shared.onMarkReady}
      onSetMergeWhenReady={shared.onSetMergeWhenReady}
      queueByKey={shared.queueByKey}
      watchesByKey={shared.watchesByKey}
    />
    )
  return <StackLockContext.Provider value={stackLock}>{rows}</StackLockContext.Provider>
}

/** The first row of a stack that just opened only draws its rail. The rows under it come in one after another. */
function unfoldClass(index: number | null): string {
  return index === null ? '' : index === 0 ? ' unfold-top' : ' unfold'
}

function unfoldStyle(index: number | null): CSSProperties | undefined {
  return index === null ? undefined : ({ '--i': index } as CSSProperties)
}

function DataRow({
  mode,
  pr,
  flip,
  unfold,
  block,
  child,
  spine,
  rail,
  tone,
  toggle,
  initiatives,
  prByKey,
  showRepo,
  hideIssue,
  linearConfigured,
  onAssign,
  onCreateAssigned,
  onMerge,
  onRetry,
  onStackMerge,
  onMarkReady,
  onSetMergeWhenReady,
  queueByKey,
  watchesByKey,
  onRerun,
  onRebase,
  onRefreshPr,
  onUpdateIssue,
  onLinkIssue,
}: {
  mode: 'mine' | 'review'
  pr: PullRequest
  /** The row's name for sliding it to a new place. */
  flip: string
  /** Its place in a stack that has just been opened, or null. */
  unfold: number | null
  block: StackBlock
  child: boolean
  spine: Spine | null
  rail: Rail | null
  tone: 'a' | 'b' | null
  toggle: { id: string; open: boolean; onToggle: (id: string) => void } | null
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  showRepo: boolean
  hideIssue?: string
  linearConfigured: boolean
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
  queueByKey: Map<string, RowMark>
  watchesByKey: Map<string, MergeWatch>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onRebase: (key: string) => Promise<void>
  onRefreshPr: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
}) {
  const holds = useHolds()
  const { locked } = useStackLock()
  const mark = queueByKey.get(pr.key) ?? null
  const ci = shownLevel([pr], holds)
  const prHref = usePrHref(pr.url)
  const motion = useContext(MotionContext)
  return (
    <tr
      className={`${child ? 'child' : ''} ${ci === 'red' ? 'fail' : ''} ${toggle ? 'stack' : ''}${pr.isDraft ? ' draft' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${rail ? ' forked' : ''}${spineClass(spine, tone)}${unfoldClass(unfold)}${motionClass([pr.key], motion)}`}
      style={unfoldStyle(unfold)}
      data-row={pr.key}
      data-flip={flip}
      onClick={(event) => {
        if (!toggle) return
        if (pressedControl(event.target)) return
        toggle.onToggle(toggle.id)
      }}
    >
      <Grip spine={spine} rail={rail} />
      <CopyNumber repoName={pr.repoName} number={pr.number} />
      <td className="title-block">
        <div className="title-line">
          {pr.isDraft ? <span className="pill draft">Draft</span> : null}
          <a href={prHref} target="_blank" rel="noreferrer" title={pr.title}>
            {pr.title}
          </a>
        </div>
        <Subline
          menuScope={pr.id}
          issues={hideIssue ? [] : pr.linearIssues}
          linearConfigured={linearConfigured}
          onUpdateIssue={onUpdateIssue}
        />
      </td>
      {mode === 'review' ? (
        <td className="author">
          <Authors people={[{ login: pr.author, avatarUrl: pr.authorAvatarUrl ?? null }]} />
        </td>
      ) : null}
      {showRepo ? (
        <td className="repo">
          <RepoIcon repo={pr.repo} label />
        </td>
      ) : null}
      <Size additions={pr.additions} deletions={pr.deletions} files={pr.changedFiles} />
      <Age id={`age:${pr.id}`} readyAt={pr.isDraft ? null : (pr.readyAt ?? pr.createdAt)} createdAt={pr.createdAt} />
      <When iso={pr.updatedAt} />
      <td>
        <CiControl id={`ci:${pr.id}`} prs={[pr]} onRerun={onRerun} />
      </td>
      {pr.conflict ? (
        <Conflict id={`conflict:${pr.id}`} prs={[pr]} />
      ) : (
        <UpToDate id={`uptodate:${pr.id}`} targetKey={pr.behind ? pr.key : null} stackKeys={block.stackKeys} parents={block.parents} prByKey={prByKey} onRebase={onRebase} />
      )}
      <td>
        <ReviewControl id={`review:${pr.id}`} prs={[pr]} />
      </td>
      <td>
        <Feedback mode={mode} targets={[feedbackTarget(pr)]} />
      </td>
      <Agents id={`agents:${pr.id}`} prs={[pr]} />
      {mode === 'mine' ? (
        <td className="merge">
          {motion.leaving.has(pr.key) ? <span className="pill queue merged">Merged</span> : null}
          <MergeControls
            pr={pr}
            ordered={mergeLineOf(block, pr.key, prByKey)}
            mark={mark}
            onMerge={onMerge}
            onRetry={onRetry}
            onStackMerge={onStackMerge}
            onMarkReady={onMarkReady}
            watch={watchesByKey.get(pr.key) ?? null}
            onSetMergeWhenReady={onSetMergeWhenReady}
          />
        </td>
      ) : null}
      <OpenLinks url={pr.url} repo={pr.repo} number={pr.number} />
      <RowMenu
        id={`menu:${pr.id}`}
        primaryKey={pr.key}
        prs={[pr]}
        stackKeys={block.stackKeys}
        parents={block.parents}
        defaultWholeStack={false}
        initiatives={initiatives}
        prByKey={prByKey}
        onAssign={onAssign}
        onCreate={onCreateAssigned}
        onRefresh={onRefreshPr}
        linearConfigured={linearConfigured}
        onLinkIssue={onLinkIssue}
      />
    </tr>
  )
}

function SummaryRow({
  mode,
  block,
  visible,
  flip,
  openId,
  spine,
  tone,
  initiatives,
  prByKey,
  showRepo,
  hideIssue,
  linearConfigured,
  onToggle,
  onAssign,
  onCreateAssigned,
  onRerun,
  onRebase,
  onRefreshPr,
  onUpdateIssue,
  onLinkIssue,
  onMerge,
  onRetry,
  onStackMerge,
  onMarkReady,
  onSetMergeWhenReady,
  queueByKey,
  watchesByKey,
}: {
  mode: 'mine' | 'review'
  block: StackBlock
  visible: PullRequest[]
  flip: string
  openId: string
  spine: Spine
  tone: 'a' | 'b' | null
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  showRepo: boolean
  hideIssue?: string
  linearConfigured: boolean
  onToggle: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onRebase: (key: string) => Promise<void>
  onRefreshPr: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
  queueByKey: Map<string, RowMark>
  watchesByKey: Map<string, MergeWatch>
}) {
  const holds = useHolds()
  const summary = block.summary
  const summaryHref = usePrHref(summary.url)
  const ci = shownLevel(visible, holds)
  const issues = hideIssue ? [] : sharedIssues(visible)
  const top = prByKey.get(summary.topKey) ?? null
  const ordered = mergeLineOf(block, summary.topKey, prByKey)
  const mark = foremost(block.stackKeys, queueByKey)
  const { locked } = useStackLock()
  const viewer = useViewer()
  // Bottom of the stack first, so the strip reads in the order the pull requests merge.
  const segments = visible
    .slice()
    .reverse()
    .map((pr) => ({ pr, state: segmentState(pr, mergeLineOf(block, pr.key, prByKey), mode, viewer) }))
  const forest = segmentForest(segments, block.parents)
  const branches = branchCount(forest)
  const readyCount = segments.filter((segment) => segment.state === 'ready').length
  const allDraft = summary.draftCount === visible.length
  const motion = useContext(MotionContext)
  return (
    <tr
      className={`stack ${ci === 'red' ? 'fail' : ''}${allDraft ? ' draft' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}${motionClass(visible.map((pr) => pr.key), motion)}`}
      data-row={openId}
      data-flip={flip}
      onClick={(event) => {
        if (pressedControl(event.target)) return
        onToggle(openId)
      }}
    >
      <Grip spine={spine} />
      <CopyNumber repoName={summary.repoName} number={summary.number} />
      <td className="title-block">
        <div className="title-line">
          {summary.draftCount > 0 ? (
            <span className="pill draft">{summary.draftCount === visible.length ? 'Draft' : `${summary.draftCount} draft`}</span>
          ) : null}
          <span
            className="segments"
            role="img"
            title={`${readyCount} of ${segments.length} ${mode === 'review' ? 'approved by you' : 'ready to merge'}`}
            aria-label={`${segments.length} pull requests, bottom of the stack first: ${segments.map((segment) => SEGMENT_LABEL[mode][segment.state]).join(', ')}`}
          >
            <SegmentRun nodes={forest} mode={mode} marks={queueByKey} />
          </span>
          <a href={summaryHref} target="_blank" rel="noreferrer" title={summary.title}>
            {summary.title}
          </a>
          {branches > 1 ? <span className="pill">{branches} branches</span> : null}
          {summary.partial ? <span className="pill">partial</span> : null}
        </div>
        <Subline
          menuScope={block.id}
          issues={issues}
          linearConfigured={linearConfigured}
          onUpdateIssue={onUpdateIssue}
        />
      </td>
      {mode === 'review' ? (
        <td className="author">
          <Authors people={summary.authors ?? []} />
        </td>
      ) : null}
      {showRepo ? (
        <td className="repo">
          <RepoIcon repo={summary.repo} label />
        </td>
      ) : null}
      <Size additions={summary.additions} deletions={summary.deletions} files={summary.changedFiles} />
      <Age id={`age:${block.id}`} readyAt={summary.readyAt} createdAt={summary.createdAt} />
      <When iso={summary.updatedAt} />
      <td>
        <CiControl id={`ci:${block.id}`} prs={visible} onRerun={onRerun} />
      </td>
      {summary.conflict ? (
        <Conflict id={`conflict:${block.id}`} prs={visible} />
      ) : (
        <UpToDate
          id={`uptodate:${block.id}`}
          targetKey={lowestBehindKey(block.stackKeys, visible)}
          stackKeys={block.stackKeys}
          parents={block.parents}
          prByKey={prByKey}
          onRebase={onRebase}
        />
      )}
      <td>
        <ReviewControl id={`review:${block.id}`} prs={visible} summary={summary} />
      </td>
      <td>
        <Feedback mode={mode} targets={visible.map(feedbackTarget)} />
      </td>
      <Agents id={`agents:${block.id}`} prs={visible} />
      {mode === 'mine' ? (
      <td className="merge">
        {top && !summary.partial ? (
          <MergeControls
            pr={top}
            ordered={ordered}
            mark={mark}
            progress
            onMerge={onMerge}
            onRetry={onRetry}
            onStackMerge={onStackMerge}
            onMarkReady={onMarkReady}
            watch={watchesByKey.get(top.key) ?? null}
            onSetMergeWhenReady={onSetMergeWhenReady}
          />
        ) : mark ? (
          <QueueStatus mark={mark} progress onRetry={onRetry} />
        ) : null}
      </td>
      ) : null}
      <OpenLinks url={summary.url} repo={summary.repo} number={summary.number} />
      <RowMenu
        id={`menu:${block.id}`}
        primaryKey={summary.topKey}
        prs={visible}
        stackKeys={block.stackKeys}
        parents={block.parents}
        defaultWholeStack
        initiatives={initiatives}
        prByKey={prByKey}
        onAssign={onAssign}
        onCreate={onCreateAssigned}
        onRefresh={onRefreshPr}
        linearConfigured={linearConfigured}
        onLinkIssue={onLinkIssue}
      />
    </tr>
  )
}

function CopyNumber({ repoName, number }: { repoName: string; number: number }) {
  const id = prCopyId(repoName, number)
  return (
    <td className="num">
      <button
        type="button"
        className="num-copy"
        title={`Copy ${id}`}
        aria-label={`Copy ${id}`}
        onClick={(event) => {
          event.stopPropagation()
          void copyPlain(id, `Copied ${id}`)
        }}
      >
        <span className="num-value">{number}</span>
        <CopyIcon />
      </button>
    </td>
  )
}

function CopyIcon() {
  return (
    <svg className="copy-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.75 5.25V3.15A1.15 1.15 0 0 0 9.6 2H3.15A1.15 1.15 0 0 0 2 3.15V9.6c0 .64.51 1.15 1.15 1.15H5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

async function copyPlain(text: string, confirmation: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toastSuccess(confirmation)
    return true
  } catch {
    toastError('Could not copy to the clipboard')
    return false
  }
}

/** The chosen pull request and each one below it, closest to the trunk first. */
/** Rich text where the clipboard takes it, so links survive a paste into Slack. */
async function copyRich(message: ChaseMessage, confirmation: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([message.html], { type: 'text/html' }),
          'text/plain': new Blob([message.text], { type: 'text/plain' }),
        }),
      ])
    } else {
      await navigator.clipboard.writeText(message.text)
    }
    toastSuccess(confirmation)
    return true
  } catch {
    toastError('Could not copy to the clipboard')
    return false
  }
}

/** Every pull request in the stack, bottom first. */
function stackTargets(stackKeys: string[], parents: Parents, prByKey: Map<string, PullRequest>): PullRequest[] {
  return stackKeys
    .map((key, index) => ({ pr: prByKey.get(key), depth: downstackKeys(parents, key).length, index }))
    .filter((item): item is { pr: PullRequest; depth: number; index: number } => item.pr != null)
    .sort((a, b) => a.depth - b.depth || b.index - a.index)
    .map((item) => item.pr)
}

function downstackTargets(
  parents: Parents,
  primaryKey: string,
  prByKey: Map<string, PullRequest>,
  shown: PullRequest[],
): PullRequest[] {
  const chain = downstackKeys(parents, primaryKey)
    .reverse()
    .flatMap((key) => {
      const pr = prByKey.get(key)
      return pr ? [pr] : []
    })
  return chain.length ? chain : shown.filter((pr) => pr.key === primaryKey)
}

function lane(index: number, span = 0): CSSProperties {
  return { '--lane': index, '--span': span } as CSSProperties
}

/** `rail` is set on a stack with branches. `hollow` is a line that stands for pull requests not shown. */
function Grip({ spine, rail = null, hollow = false }: { spine: Spine | null; rail?: Rail | null; hollow?: boolean }) {
  return (
    <td className="grip">
      {spine === 'only' ? <span className="stack-mark" aria-hidden="true" /> : null}
      {rail ? (
        <span className="rails" aria-hidden="true">
          {rail.through.map((index) => (
            <i key={`through-${index}`} className="rail through" style={lane(index)} />
          ))}
          {rail.up ? <i className="rail up" style={lane(rail.lane)} /> : null}
          {rail.down ? <i className="rail down" style={lane(rail.lane)} /> : null}
          {rail.joins.map((index) => (
            <i key={`join-${index}`} className="rail join" style={lane(rail.lane, index - rail.lane)} />
          ))}
          <i className={`rail node${hollow ? ' hollow' : ''}`} style={lane(rail.lane)} />
        </span>
      ) : null}
    </td>
  )
}

type SegmentNode = { pr: PullRequest; state: SegmentState; above: SegmentNode[] }

/** The shown pull requests as a tree, bottom first. One hidden in between does not break the line. */
function segmentForest(bottomFirst: { pr: PullRequest; state: SegmentState }[], parents: Parents): SegmentNode[] {
  const nodes = new Map<string, SegmentNode>(bottomFirst.map((item) => [item.pr.key, { ...item, above: [] }]))
  const roots: SegmentNode[] = []
  // Top first, so the branch that is listed first is also drawn first.
  for (const item of bottomFirst.slice().reverse()) {
    const node = nodes.get(item.pr.key)!
    const below = downstackKeys(parents, item.pr.key)
      .slice(1)
      .find((key) => nodes.has(key))
    if (below) nodes.get(below)!.above.push(node)
    else roots.push(node)
  }
  return roots
}

function branchCount(nodes: SegmentNode[]): number {
  return nodes.reduce((total, node) => total + (node.above.length ? branchCount(node.above) : 1), 0)
}

/** One segment for each pull request. Where the stack branches, each branch gets its own line. */
function SegmentRun({ nodes, mode, marks }: { nodes: SegmentNode[]; mode: 'mine' | 'review'; marks: Map<string, RowMark> }) {
  const { leaving } = useContext(MotionContext)
  if (nodes.length === 0) return null
  if (nodes.length > 1) {
    return (
      <span className="seg-fork">
        {nodes.map((node) => (
          <span key={node.pr.id} className="segments">
            <SegmentRun nodes={[node]} mode={mode} marks={marks} />
          </span>
        ))}
      </span>
    )
  }
  const node = nodes[0]!
  // While the stack is in the merge queue, the segment being merged pulses and the ones that have landed are green.
  const step = marks.get(node.pr.key)?.status
  const queued = step === 'merged' || step === 'restacked' ? ' q-done' : step === 'merging' || step === 'rebasing' || step === 'waiting' ? ' q-live' : ''
  return (
    <>
      <i className={`seg ${node.state}${queued}${leaving.has(node.pr.key) ? ' leaving' : ''}`} title={`#${node.pr.number} · ${step ? stepLabel(step) : SEGMENT_LABEL[mode][node.state]}`} />
      <SegmentRun nodes={node.above} mode={mode} marks={marks} />
    </>
  )
}

function OpenLinks({ url, repo, number }: { url: string; repo: string; number: number }) {
  return (
    <td className="open">
      <span className="open-links">
        <a href={url} target="_blank" rel="noreferrer" title="Open in GitHub" aria-label={`Open #${number} in GitHub`}>
          <GithubIcon />
        </a>
        <a
          href={graphitePrUrl(repo, number)}
          target="_blank"
          rel="noreferrer"
          title="Open in Graphite"
          aria-label={`Open #${number} in Graphite`}
        >
          <GraphiteIcon />
        </a>
      </span>
    </td>
  )
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  )
}

function RobotIcon() {
  return (
    <svg className="robot-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.6v2.2" />
      <rect x="3" y="3.8" width="10" height="8.4" rx="2.2" />
      <path d="M1.2 7.2v2.2M14.8 7.2v2.2M6.4 14.4h3.2" />
      <path d="M6 7.4v1.4M10 7.4v1.4" />
    </svg>
  )
}

function GraphiteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1.2 2.4 4.4v7.2L8 14.8l5.6-3.2V4.4L8 1.2Zm0 1.85 3.85 2.2v.01L8 7.45 4.15 5.26 8 3.05Zm-4.4 3.4 3.85 2.2v4.35L3.6 10.8V6.45Zm5 6.55V8.65l3.85-2.2v4.35L8.6 13Z"
      />
    </svg>
  )
}

function SectionIssue({
  bucket,
  onUpdateIssue,
}: {
  bucket: Bucket
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const issue = bucketIssue(bucket)
  if (!issue || !isLinearIdentifier(issue.identifier)) return null
  return <IssueControls menuKey={`section:${bucket.id}`} issue={issue} onUpdate={onUpdateIssue} />
}

function bucketIssue(bucket: Bucket): LinearIssue | null {
  if (!bucket.issueId) return null
  for (const block of [...bucket.stacks, ...bucket.singles]) {
    for (const row of block.rows) {
      if (row.type !== 'pr') continue
      const issue = row.pr.linearIssues.find((item) => item.identifier === bucket.issueId)
      if (issue) return issue
    }
  }
  return null
}

function sharedIssues(prs: PullRequest[]): LinearIssue[] {
  const issues = prs.flatMap((pr) => pr.linearIssues)
  const ids = [...new Set(issues.map((issue) => issue.identifier))]
  if (ids.length === 1) return issues.filter((issue) => issue.identifier === ids[0]).slice(0, 1)
  if (ids.length > 1) {
    return [{ identifier: `${ids.length} issues`, title: null, url: null, projectId: null, projectName: null }]
  }
  return []
}

function Subline({
  menuScope,
  issues,
  linearConfigured,
  onUpdateIssue,
}: {
  menuScope: string
  issues: LinearIssue[]
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const { locked } = useStackLock()
  if (issues.length === 0) return null
  return (
    <div className="subline">
      {issues.map((issue) => (
        <span key={issue.identifier} className="issue-ref">
          {linearConfigured && isLinearIdentifier(issue.identifier) ? (
            <IssueControls menuKey={`${menuScope}:${issue.identifier}`} issue={issue} disabled={locked} onUpdate={onUpdateIssue} />
          ) : null}
          {issue.url ? (
            <a href={issue.url} target="_blank" rel="noreferrer">
              {issue.identifier}
              {issue.title ? ` · ${issue.title}` : ''}
            </a>
          ) : (
            <span>
              {issue.identifier}
              {issue.title ? ` · ${issue.title}` : ''}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

function Conflict({ id, prs }: { id: string; prs: PullRequest[] }) {
  const conflicts = prs.filter((pr) => pr.conflict)
  const { launch, pending, error } = useAgentLaunch()
  const name = useAgentName(prs[0]?.repo ?? null)
  const { locked } = useStackLock()

  if (conflicts.length === 0) {
    return (
      <td className="conflict">
        <span className="sr">No conflict</span>
      </td>
    )
  }

  return (
    <td className="conflict">
      <span className="conflict-cell">
        <ClickCard
          id={id}
          className="conflict-x"
          disabled={locked}
          label={
            <>
              <span className="sr">Resolve merge conflict with {name}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </>
          }
        >
          <h3>Resolve with {name}</h3>
          <p>{name} will resolve the conflict and push to this pull request’s existing branch.</p>
          {conflicts.map((pr) => {
            const running = activeSession(pr, 'conflict')
            const request: AgentRequest = { kind: 'conflict' }
            return (
              <div key={pr.key} className="resolve-action">
                {conflicts.length > 1 ? <p>#{pr.number}</p> : null}
                {running ? (
                  <RunningNote session={running} />
                ) : (
                  <button
                    type="button"
                    className="primary resolve-cta"
                    disabled={locked || pending !== null}
                    aria-label={conflicts.length > 1 ? `Resolve #${pr.number} with ${name}` : undefined}
                    onClick={() => void launch(pr, request)}
                  >
                    {pending === launchTag(pr.key, request) ? `Starting ${name}…` : `Resolve with ${name}`}
                  </button>
                )}
              </div>
            )
          })}
          {error ? <p className="launch-error">{error}</p> : null}
        </ClickCard>
      </span>
    </td>
  )
}

function RunningNote({ session, prefix = null }: { session: AgentSession; prefix?: string | null }) {
  const { webUrl } = useSessionLinks(session)
  return (
    <p>
      {prefix ? `${prefix} · ` : ''}
      {sessionStatusLabel(session.status)}. {agentWork(session.kind, session.provider)}{' '}
      {webUrl ? (
        <a className="external" href={webUrl} target="_blank" rel="noreferrer">
          Open session
        </a>
      ) : null}
    </p>
  )
}

function Agents({ id, prs }: { id: string; prs: PullRequest[] }) {
  const sessions = prs
    .flatMap((pr) => (pr.agentSessions ?? []).map((session) => ({ pr, session })))
    .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
  const { locked } = useStackLock()
  const closeMenu = useMenuClose()
  const [drawer, setDrawer] = useState<{ focus: string | null } | null>(null)
  if (sessions.length === 0) {
    return (
      <td className="agents">
        <span className="sr">No agents</span>
      </td>
    )
  }
  const lead = leadingStatus(sessions.map((item) => item.session.status)) ?? 'running'
  const active = sessions.filter((item) => sessionActive(item.session.status)).length
  const only = sessions.length === 1 ? sessions[0]!.session : null
  const spoken = only
    ? `${providerLabel(only.provider)} agent, ${agentKindLabel(only.kind)}, ${sessionStatusLabel(only.status)}`
    : `${sessions.length} agents, ${active} active`
  const label = (
    <>
      <span className="sr">{spoken}</span>
      <span aria-hidden="true">{sessions.length}</span>
    </>
  )
  function open(focus: string | null) {
    closeMenu()
    setDrawer({ focus })
  }
  return (
    <td className="agents">
      <ClickCard id={id} disabled={locked} className={`cursor-chip ${lead}`} panelClassName="agent-panel" closable={false} label={label}>
        <AgentList items={sessions} showPr={prs.length > 1} onOpen={open} />
      </ClickCard>
      {drawer ? <AgentDrawer prs={prs} items={sessions} focus={drawer.focus} onClose={() => setDrawer(null)} /> : null}
    </td>
  )
}

function UpToDate({
  id,
  targetKey,
  stackKeys,
  parents,
  prByKey,
  onRebase,
}: {
  id: string
  targetKey: string | null
  stackKeys: string[]
  parents: Parents
  prByKey: Map<string, PullRequest>
  onRebase: (key: string) => Promise<void>
}) {
  const plan = targetKey ? rebasePlan(stackKeys, parents, targetKey, prByKey) : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked, lock, unlock } = useStackLock()
  const close = useMenuClose()

  async function rebase(target: PullRequest) {
    if (pending) return
    if (!lock()) return
    setError(null)
    setPending(true)
    try {
      await onRebase(target.key)
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rebase.')
    } finally {
      setPending(false)
      unlock()
    }
  }

  if (!plan) {
    return (
      <td className="uptodate">
        <span className="sr">Up to date</span>
      </td>
    )
  }

  const { target, above } = plan
  return (
    <td className="uptodate">
      <ClickCard
        id={id}
        className="uptodate-x"
        disabled={locked && !pending}
        label={
          <>
            <span className="sr">Not up to date. Rebase onto the base branch</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </>
        }
      >
        <h3>Rebase</h3>
        <p>{rebaseCopy(target, above)}</p>
        <button type="button" className="menu-item" disabled={pending || locked} onClick={() => void rebase(target)}>
          {pending ? 'Rebasing…' : 'Rebase'}
        </button>
        {error ? <p className="launch-error">{error}</p> : null}
      </ClickCard>
    </td>
  )
}

function rebasePlan(
  stackKeys: string[],
  parents: Parents,
  targetKey: string,
  prByKey: Map<string, PullRequest>,
): { target: PullRequest; above: PullRequest[] } | null {
  const target = prByKey.get(targetKey)
  if (!target) return null
  const above = upstackKeys(stackKeys, parents, targetKey).flatMap((key) => {
    const pr = prByKey.get(key)
    return pr ? [pr] : []
  })
  return { target, above }
}

/** Walks up from the trunk, so the one it finds has nothing behind beneath it. */
function lowestBehindKey(stackKeys: string[], prs: PullRequest[]): string | null {
  const behind = new Set(prs.filter((pr) => pr.behind).map((pr) => pr.key))
  for (let index = stackKeys.length - 1; index >= 0; index--) {
    const key = stackKeys[index]!
    if (behind.has(key)) return key
  }
  return null
}

function rebaseCopy(target: PullRequest, above: PullRequest[]): string {
  const onto = `the latest commit of ${target.baseRef}`
  if (above.length === 0) return `Rebase #${target.number} onto ${onto}.`
  const names = above.map((pr) => `#${pr.number}`)
  const list =
    names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
  return `Rebase #${target.number} onto ${onto}. ${list} ${above.length === 1 ? 'is' : 'are'} restacked with it.`
}

type RowMenuProps = {
  id: string
  primaryKey: string
  /** Pull requests shown on this row. */
  prs: PullRequest[]
  stackKeys: string[]
  parents: Parents
  defaultWholeStack: boolean
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreate: (name: string, keys: string[]) => Promise<void>
  onRefresh: (key: string) => Promise<void>
  linearConfigured: boolean
  onLinkIssue: (key: string, identifier: string) => Promise<void>
}

function RowMenu(props: RowMenuProps) {
  const { locked } = useStackLock()
  return (
    <td className="row-actions">
      <ClickCard
        id={props.id}
        className="row-menu"
        closable={false}
        disabled={locked}
        label={
          <>
            <span className="sr">Row actions</span>
            <span aria-hidden="true">⋯</span>
          </>
        }
      >
        <RowMenuBody {...props} />
      </ClickCard>
    </td>
  )
}

function RowMenuBody(props: RowMenuProps) {
  const [view, setView] = useState<'menu' | 'initiative' | 'prompt' | 'issue'>('menu')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = useMenuClose()
  const agents = useAgentLaunch()
  const pr = props.prByKey.get(props.primaryKey)
  const name = useAgentName(pr?.repo ?? props.prs[0]?.repo ?? null)
  const promptTargets = props.prs.length ? props.prs : pr ? [pr] : []
  const failing = props.prs.filter((item) => failingChecks(item).length > 0)
  const copyTargets = downstackTargets(props.parents, props.primaryKey, props.prByKey, props.prs)
  const stack = props.stackKeys.length > 1 ? stackTargets(props.stackKeys, props.parents, props.prByKey) : []
  const chases = [
    ...(pr && !props.defaultWholeStack ? [{ label: `Copy review chase for #${pr.number}`, prs: [pr] }] : []),
    ...(stack.length > 1 ? [{ label: 'Copy review chase for stack', prs: stack }] : []),
  ]

  if (view === 'initiative') {
    return (
      <TagEditor
        primaryKey={props.primaryKey}
        stackKeys={props.stackKeys}
        defaultWholeStack={props.defaultWholeStack}
        prByKey={props.prByKey}
        initiatives={props.initiatives}
        onAssign={props.onAssign}
        onCreate={props.onCreate}
      />
    )
  }
  if (view === 'prompt') {
    return <AgentPromptForm prs={promptTargets} initialKey={props.primaryKey} onStarted={close} />
  }
  if (view === 'issue') {
    return <LinkIssueForm prs={promptTargets} initialKey={props.primaryKey} onLink={props.onLinkIssue} />
  }
  return (
    <>
      {pr ? (
        <button
          type="button"
          className="menu-item"
          disabled={pending}
          onClick={() => {
            setPending(true)
            setError(null)
            void props.onRefresh(props.primaryKey)
              .then(() => close())
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : 'Could not refresh that pull request')
              })
              .finally(() => setPending(false))
          }}
        >
          {pending ? 'Refreshing…' : `Refresh #${pr.number}`}
        </button>
      ) : null}
      {copyTargets.length ? (
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const text = prCopyList(copyTargets)
            const confirmation = copyTargets.length === 1 ? `Copied ${text}` : `Copied ${copyTargets.length} PR IDs`
            void copyPlain(text, confirmation).then((copied) => {
              if (copied) close()
            })
          }}
        >
          {copyPrIdsLabel(copyTargets.length)}
        </button>
      ) : null}
      {chases.map((chase) => {
        const message = reviewChase(chase.prs)
        return (
          <button
            key={chase.label}
            type="button"
            className="menu-item"
            disabled={!message}
            title={message ? undefined : 'Nothing left to review'}
            onClick={() => {
              if (!message) return
              void copyRich(message, 'Copied review chase').then((copied) => {
                if (copied) close()
              })
            }}
          >
            {chase.label}
          </button>
        )
      })}
      {promptTargets.length ? (
        <button type="button" className="menu-item" onClick={() => setView('prompt')}>
          Work on {promptTargets.length > 1 ? 'a pull request' : `#${promptTargets[0]!.number}`} with {name}…
        </button>
      ) : null}
      {failing.map((item) => {
        const request: AgentRequest = { kind: 'ci' }
        const running = activeSession(item, 'ci')
        return (
          <button
            key={item.key}
            type="button"
            className="menu-item external"
            disabled={running !== null || agents.pending !== null}
            onClick={() => {
              void agents.launch(item, request).then((opened) => {
                if (opened) close()
              })
            }}
          >
            {agents.pending === launchTag(item.key, request)
              ? `Starting ${name}…`
              : running
                ? `${providerLabel(running.provider)} is investigating CI on #${item.number}`
                : `Investigate CI failure on #${item.number}`}
          </button>
        )
      })}
      {props.linearConfigured && promptTargets.length ? (
        <button type="button" className="menu-item" onClick={() => setView('issue')}>
          Link Linear issue…
        </button>
      ) : null}
      <button type="button" className="menu-item" onClick={() => setView('initiative')}>
        Set initiative
      </button>
      {error ? <p>{error}</p> : null}
      {agents.error ? <p className="launch-error">{agents.error}</p> : null}
    </>
  )
}

function AgentPromptForm({ prs, initialKey, onStarted }: { prs: PullRequest[]; initialKey: string; onStarted: () => void }) {
  const [key, setKey] = useState(prs.some((pr) => pr.key === initialKey) ? initialKey : prs[0]!.key)
  const [text, setText] = useState('')
  const { launch, pending, error } = useAgentLaunch()
  const pr = prs.find((item) => item.key === key) ?? prs[0]!
  const name = useAgentName(pr.repo)
  const busy = pending !== null
  const ready = text.trim().length > 0 && text.length <= PROMPT_LIMIT
  return (
    <form
      className="agent-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        void launch(pr, { kind: 'prompt', prompt: text }).then((opened) => {
          if (opened) onStarted()
        })
      }}
    >
      <h3>Work on #{pr.number} with {name}</h3>
      <p>{name} gets this pull request’s link, branches, and linked issues, and pushes to its existing branch.</p>
      {prs.length > 1 ? (
        <label className="agent-target">
          Pull request
          <select className="select" value={key} disabled={busy} onChange={(event) => setKey(event.target.value)}>
            {prs.map((item) => (
              <option key={item.key} value={item.key}>
                #{item.number} {item.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <textarea
        aria-label={`Prompt for ${name}`}
        placeholder={`What should ${name} do?`}
        rows={5}
        autoFocus
        value={text}
        disabled={busy}
        maxLength={PROMPT_LIMIT}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <p className="faint reply-hint">⌘↵ to start</p>
      <button type="submit" className="primary resolve-cta" disabled={!ready || busy}>
        {busy ? `Starting ${name}…` : 'Start agent'}
      </button>
      {error ? <p className="launch-error">{error}</p> : null}
    </form>
  )
}

function Size({ additions, deletions, files }: { additions: number; deletions: number; files: number }) {
  const fileLabel = `${files.toLocaleString('en-GB')} ${files === 1 ? 'file' : 'files'}`
  return (
    <>
      <td className="size add">+{formatCount(additions)}</td>
      <td className="size del">−{formatCount(deletions)}</td>
      <td className="size files" title={fileLabel} aria-label={fileLabel}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 1.75h5.15L13.1 5.7V13.2c0 .58-.47 1.05-1.05 1.05H4A1.05 1.05 0 0 1 2.95 13.2V2.8C2.95 2.22 3.42 1.75 4 1.75Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9.05 1.9v3.85h3.85" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {formatCount(files)}
      </td>
    </>
  )
}

const RING = 2 * Math.PI * 6

/**
 * Time since review could start, as a ring that fills over two days and takes the age's colour. The time itself is in the card.
 * A draft has a dotted ring that never fills, for the time since it was opened.
 */
function Age({ id, readyAt, createdAt }: { id: string; readyAt: string | null; createdAt: string }) {
  const heat = ageHeat(readyAt)
  const web = cobwebTier(readyAt)
  const since = readyAt ?? createdAt
  const heading = !readyAt ? `Draft, opened ${formatAgo(createdAt)}` : readyAt === createdAt ? `Opened ${formatAgo(createdAt)}` : `Ready for review ${formatAgo(readyAt)}`
  const label = (
    <>
      <span className="sr">{heading}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        {readyAt ? <circle className="arc" cx="8" cy="8" r="6" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0.04, ageFill(readyAt)))} /> : null}
      </svg>
    </>
  )
  return (
    <td className={`when age ${heat.level}`} style={{ '--heat': `${Math.round(heat.warmth * 100)}%` } as CSSProperties}>
      {web ? <Cobweb tier={web} /> : null}
      <HoverCard id={id} className={`age-ring${readyAt ? '' : ' draft'}`} label={label}>
        <h3>{heading}</h3>
        <p className="age-line">{formatExact(since)}</p>
        {readyAt && readyAt !== createdAt ? <p>Opened {formatExact(createdAt)}</p> : null}
        {web ? <p>{web === 3 ? 'Over a month. The spider has moved in.' : web === 2 ? 'Over two weeks, and gathering cobwebs.' : 'Over five days. The first cobweb.'}</p> : null}
      </HoverCard>
    </td>
  )
}

/** Points along the four threads a web hangs from, out of the cell's top corner. */
const SPOKES = [[28, 3], [23, 14], [14, 23], [3, 28]] as const
const WEB_RINGS = { 1: [0.5, 0.85], 2: [0.34, 0.6, 0.86], 3: [0.24, 0.44, 0.64, 0.84] } as const

function Cobweb({ tier }: { tier: 1 | 2 | 3 }) {
  const at = (spoke: readonly [number, number], far: number) => `${(spoke[0] * far).toFixed(1)} ${(spoke[1] * far).toFixed(1)}`
  // Each ring sags towards the corner between one thread and the next.
  const rings = WEB_RINGS[tier].map((far) =>
    SPOKES.map((spoke, index) => {
      if (index === 0) return `M${at(spoke, far)}`
      const before = SPOKES[index - 1]!
      return `Q${at([(spoke[0] + before[0]) / 2, (spoke[1] + before[1]) / 2], far * 0.8)} ${at(spoke, far)}`
    }).join(''),
  )
  return (
    <svg className={`cobweb tier-${tier}`} viewBox="0 0 30 32" aria-hidden="true">
      <path d={`${SPOKES.map((spoke) => `M0 0L${spoke[0]} ${spoke[1]}`).join('')}${rings.join('')}`} />
      {tier === 3 ? (
        <>
          <path d="M3.4 23.5V29" />
          <circle className="spider" cx="3.4" cy="29" r="1.7" />
        </>
      ) : null}
    </svg>
  )
}

/** Counts for a heading, so a collapsed section still says whether it needs you. Zero counts are left out. */
function SectionRollup({ buckets, prByKey, mode }: { buckets: Bucket[]; prByKey: Map<string, PullRequest>; mode: 'mine' | 'review' }) {
  const viewer = useViewer()
  const states = buckets.flatMap((bucket) =>
    [...bucket.stacks, ...bucket.singles].flatMap((block) =>
      block.rows.flatMap((row) =>
        row.type === 'pr' ? [segmentState(row.pr, mergeLineOf(block, row.pr.key, prByKey), mode, viewer)] : [],
      ),
    ),
  )
  const counts = rollup(states)
  if (counts.ready + counts.you + counts.broken === 0) return null
  return (
    <span className="section-roll">
      {counts.broken > 0 ? <span className="broken">{counts.broken} broken</span> : null}
      {counts.you > 0 ? <span className="you">{counts.you === 1 ? '1 needs you' : `${counts.you} need you`}</span> : null}
      {counts.ready > 0 ? <span className="ready">{counts.ready} {mode === 'review' ? 'approved by you' : 'ready'}</span> : null}
    </span>
  )
}

function When({ iso }: { iso: string }) {
  return (
    <td className="when" title={formatExact(iso)}>
      {formatWhen(iso)}
    </td>
  )
}

/** The stack as merging this pull request sees it: what gets restacked, then it and each one below it. */
function mergeLineOf(block: StackBlock, key: string, prByKey: Map<string, PullRequest>): PullRequest[] {
  const keys = mergeLineKeys(block.stackKeys, block.parents, key)
  const prs = keys.map((item) => prByKey.get(item)).filter((pr): pr is PullRequest => pr != null)
  return prs.length === keys.length ? prs : []
}

const MARK_RANK: StepStatus[] = ['failed', 'merging', 'rebasing', 'waiting', 'queued', 'restacked', 'merged', 'cancelled']

function foremost(keys: string[], marks: Map<string, RowMark>): RowMark | null {
  const found = keys.map((key) => marks.get(key)).filter((mark): mark is RowMark => mark != null)
  found.sort((a, b) => MARK_RANK.indexOf(a.status) - MARK_RANK.indexOf(b.status))
  return found[0] ?? null
}

function MergeControls({
  pr,
  ordered,
  mark,
  watch,
  progress = false,
  onMerge,
  onRetry,
  onStackMerge,
  onMarkReady,
  onSetMergeWhenReady,
}: {
  pr: PullRequest
  ordered: PullRequest[]
  mark: RowMark | null
  watch: MergeWatch | null
  progress?: boolean
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
}) {
  if (mark) return <QueueStatus mark={mark} progress={progress} onRetry={onRetry} />
  if (watch) {
    return <MergeWhenReady pr={pr} scope={watch.scope} watch={watch} onChange={onSetMergeWhenReady} />
  }
  if (pr.isDraft) return <MarkReady pr={pr} onMarkReady={onMarkReady} />
  const count = canMergeSlice(ordered, pr.key)
  if (count != null) return <StackMergeButton count={count} pr={pr} onStackMerge={onStackMerge} />
  if (canSquashMerge(pr)) return <MergeButton pr={pr} onMerge={onMerge} />
  const scope = sliceParts(ordered, pr.key) ? 'downstack' : pr.squashMergeAllowed && pr.baseRef === pr.defaultBranch ? 'pr' : null
  if (scope) return <MergeWhenReady pr={pr} scope={scope} watch={null} onChange={onSetMergeWhenReady} />
  return null
}

function MarkReady({ pr, onMarkReady }: { pr: PullRequest; onMarkReady: (key: string) => Promise<void> }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked } = useStackLock()
  const busy = pending || locked
  return (
    <div className="merge-action">
      <button
        type="button"
        className="ghost merge"
        disabled={busy}
        aria-busy={busy}
        aria-label={pending ? `Marking #${pr.number} ready for review` : `Mark #${pr.number} ready for review`}
        onClick={() => {
          if (busy) return
          setPending(true)
          setError(null)
          void onMarkReady(pr.key)
            .catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : 'Could not mark that pull request ready')
            })
            .finally(() => setPending(false))
        }}
      >
        {pending ? 'Marking…' : 'Mark as ready'}
      </button>
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function MergeWhenReady({
  pr,
  scope,
  watch,
  onChange,
}: {
  pr: PullRequest
  scope: MergeWatch['scope']
  watch: MergeWatch | null
  onChange: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked } = useStackLock()
  const checked = watch != null
  return (
    <div className="merge-action">
      <label className="merge-ready-toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending || locked}
          onChange={(event) => {
            const enabled = event.currentTarget.checked
            setPending(true)
            setError(null)
            void onChange(pr.key, scope, enabled)
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : 'Could not update merge when ready')
              })
              .finally(() => setPending(false))
          }}
        />
        <span aria-hidden="true" />
        Merge when ready
      </label>
      {watch?.detail ? <p className="merge-watch-detail">{watch.detail}</p> : null}
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function QueueStatus({ mark, progress, onRetry }: { mark: RowMark; progress: boolean; onRetry: (entryId: string) => Promise<void> }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const text = progress && mark.total > 1 ? `${stepLabel(mark.status)} · ${mark.done} of ${mark.total}` : stepLabel(mark.status)
  // A held entry is retried from the row that failed, or from the row that stands for the whole stack.
  const retry = mark.entryStatus === 'failed' && (mark.status === 'failed' || progress)
  const why = (mark.status === 'failed' || retry) && mark.detail ? mark.detail : null
  const cardId = useId()
  return (
    <div className="merge-action">
      <div className="merge-held">
        {why ? (
          <HoverCard id={`queue-why:${cardId}`} className={`pill queue ${mark.status}`} label={text}>
            <h3>Why it stopped</h3>
            <p className="merge-why">{why}</p>
          </HoverCard>
        ) : (
          <span className={`pill queue ${mark.status}`}>{text}</span>
        )}
        {retry ? (
          <button
            type="button"
            className="ghost merge"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              setPending(true)
              setError(null)
              void onRetry(mark.entryId)
                .catch((caught: unknown) => {
                  setError(caught instanceof Error ? caught.message : 'Could not retry that merge')
                })
                .finally(() => setPending(false))
            }}
          >
            {pending ? 'Retrying' : 'Retry'}
          </button>
        ) : null}
      </div>
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function StackMergeButton({
  count,
  pr,
  onStackMerge,
}: {
  count: number
  pr: PullRequest
  onStackMerge: (key: string) => Promise<void>
}) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked, lock, unlock } = useStackLock()
  const closeMenus = useMenuClose()
  const label = `Merge ${count} PRs`
  const busy = pending || locked
  return (
    <div className="merge-action">
      <button
        type="button"
        className="primary merge"
        disabled={busy}
        aria-busy={busy}
        aria-label={pending ? `Queuing #${pr.number} and ${count - 1} below` : `Squash and merge #${pr.number} and ${count - 1} below`}
        onClick={() => {
          if (pendingRef.current || locked) return
          if (!lock()) return
          pendingRef.current = true
          setPending(true)
          setError(null)
          closeMenus()
          void onStackMerge(pr.key)
            .catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : 'Could not queue that stack')
            })
            .finally(() => {
              pendingRef.current = false
              setPending(false)
              unlock()
            })
        }}
      >
        {pending ? 'Queuing' : label}
      </button>
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

/** Merging always goes through the queue. The row shows the queue's status once the entry exists. */
function MergeButton({ pr, onMerge }: { pr: PullRequest; onMerge: (key: string) => Promise<void> }) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked } = useStackLock()
  const busy = pending || locked
  return (
    <div className="merge-action">
      <button
        type="button"
        className="primary merge"
        disabled={busy}
        aria-busy={busy}
        aria-label={pending ? `Queuing #${pr.number}` : `Squash and merge #${pr.number}`}
        onClick={() => {
          if (pendingRef.current || locked) return
          pendingRef.current = true
          setPending(true)
          setError(null)
          void onMerge(pr.key).catch((caught: unknown) => {
            pendingRef.current = false
            setPending(false)
            setError(caught instanceof Error ? caught.message : 'Could not queue that pull request')
          })
        }}
      >
        {pending ? 'Queuing' : 'Merge'}
      </button>
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function Authors({ people }: { people: { login: string; avatarUrl: string | null }[] }) {
  if (people.length === 0) return <span className="author">Unknown</span>
  const shown = people.slice(0, 3)
  const label = people.length === 1 ? people[0]!.login : `${people.length} authors`
  return (
    <span className="author" title={people.map((person) => person.login).join(', ')}>
      <span className="avatars">
        {shown.map((person) =>
          person.avatarUrl ? (
            <img key={person.login} src={person.avatarUrl} alt="" />
          ) : (
            <span key={person.login} className="avatar fallback" aria-hidden="true">
              {person.login.slice(0, 1).toUpperCase()}
            </span>
          ),
        )}
      </span>
      <span className="author-name">{label}</span>
    </span>
  )
}

function CiControl({ id, prs, onRerun }: { id: string; prs: PullRequest[]; onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string> }) {
  const level = shownLevel(prs, useHolds())
  const { locked } = useStackLock()
  return (
    <ClickCard id={id} className={`ci ${level}`} disabled={locked} label={ciLabel(level)}>
      <CiPanel prs={prs} level={level} onRerun={onRerun} />
    </ClickCard>
  )
}

function CiPanel({
  prs,
  level,
  onRerun,
}: {
  prs: PullRequest[]
  level: CiDisplay
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
}) {
  const holds = useHolds()
  const invalidated = (pr: PullRequest, check: Check) =>
    (holds.get(pr.key) ?? EMPTY_HOLDS).some((hold) => hold.name === check.name && hold.stamp === checkStamp(check))
  const checks = prs.flatMap((pr) => selectChecks(pr.checks).map((check) => ({ pr, check })))
  checks.sort((a, b) => {
    const rank = Number(invalidated(b.pr, b.check)) - Number(invalidated(a.pr, a.check))
    return rank || compareChecks(a.check, b.check) || a.pr.number - b.pr.number
  })
  const grouped = new Map<string, { pr: PullRequest; check: Check }[]>()
  for (const item of checks) {
    const name = item.check.workflowName ?? 'Other'
    const list = grouped.get(name) ?? []
    list.push(item)
    grouped.set(name, list)
  }
  const heading = prs.length === 1 || level === 'invalidated' ? ciDetail(level) : 'Checks across this stack'
  return (
    <div>
      <h3>{heading}</h3>
      <RerunActions keys={prs.map((pr) => pr.key)} onRerun={onRerun} />
      <CiAgentActions prs={prs} />
      {[...grouped.entries()].map(([workflow, items]) => (
        <div key={workflow} className="check-group">
          <h4>{workflow}</h4>
          {items.map(({ pr, check }) => {
            const phase = checkPhase(check)
            const stale = invalidated(pr, check)
            const tone = stale ? 'invalidated' : phase === 'fail' ? 'fail' : phase === 'missing' || phase === 'pending' ? 'pending' : 'success'
            const state = stale
              ? 'Invalidated'
              : phase === 'fail'
                ? 'Failed'
                : phase === 'missing'
                  ? 'Not reported'
                  : phase === 'pending'
                    ? 'Running'
                    : null
            return (
              <div key={`${pr.id}:${check.name}`} className="check">
                <i className={tone} />
                <span>
                  {prs.length > 1 ? `#${pr.number} ` : ''}
                  {check.url ? (
                    <a className="external" href={check.url} target="_blank" rel="noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </span>
                <span className="req">
                  {state ? <em className={tone}>{state}</em> : null}
                  {state ? ' · ' : ''}
                  {check.required ? 'Required' : 'Optional'}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {checks.length === 0 ? <p>No checks on the latest commit.</p> : null}
    </div>
  )
}

function RerunActions({ keys, onRerun }: { keys: string[]; onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string> }) {
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<'failed' | 'all' | null>(null)
  async function run(mode: 'failed' | 'all') {
    setPending(mode)
    setMessage(null)
    try {
      setMessage(await onRerun(keys, mode))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Rerun failed')
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <div className="popover-actions">
        <button type="button" disabled={pending !== null} aria-busy={pending === 'failed'} onClick={() => void run('failed')}>
          {pending === 'failed' ? 'Rerunning…' : 'Rerun failed'}
        </button>
        <button type="button" disabled={pending !== null} aria-busy={pending === 'all'} onClick={() => void run('all')}>
          {pending === 'all' ? 'Rerunning…' : 'Rerun all'}
        </button>
      </div>
      {message ? <p>{message}</p> : null}
    </>
  )
}

function CiAgentActions({ prs }: { prs: PullRequest[] }) {
  const failing = prs.filter((pr) => failingChecks(pr).length > 0)
  const { launch, pending, error } = useAgentLaunch()
  const name = useAgentName(prs[0]?.repo ?? null)
  if (failing.length === 0) return null
  const request: AgentRequest = { kind: 'ci' }
  const idle = failing.filter((pr) => !activeSession(pr, 'ci'))
  return (
    <div className="ci-agent">
      {failing.map((pr) => {
        const running = activeSession(pr, 'ci')
        return running ? <RunningNote key={pr.key} session={running} prefix={failing.length > 1 ? `#${pr.number}` : null} /> : null
      })}
      {idle.length ? (
        <>
          <div className="popover-actions">
            {idle.map((pr) => (
              <button
                key={pr.key}
                type="button"
                disabled={pending !== null}
                aria-busy={pending === launchTag(pr.key, request)}
                onClick={() => void launch(pr, request)}
              >
                {pending === launchTag(pr.key, request)
                  ? `Starting ${name}…`
                  : `Investigate ${failing.length > 1 ? `#${pr.number} ` : ''}with ${name}`}
              </button>
            ))}
          </div>
          <p>{name} reads the failing logs, pushes a fix if the cause is clear, and reports back if it is not.</p>
        </>
      ) : null}
      {error ? <p className="launch-error">{error}</p> : null}
    </div>
  )
}

function mergeTitle(mark: MergeMark, changes: boolean): string {
  if (changes) return 'Changes requested'
  if (mark === 'met') return 'Enough to merge'
  if (mark === 'unmet') return 'Review still required'
  if (mark === 'draft') return 'Draft, no review requirement'
  return 'No review requirement'
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.2 6.4 11.4 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MergeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M3.15 3a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7Zm0 7.3a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7Z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M3.15 5.7v4.6M3.15 8H8.6" />
      <path fill="currentColor" d="M8.4 5.55 13.1 8 8.4 10.45Z" />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5" r="2.15" fill="currentColor" />
      <path d="M3.5 13.15c.6-2.45 2.2-3.65 4.5-3.65s3.9 1.2 4.5 3.65" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function reviewClass(done: boolean, waiting: boolean) {
  if (done) return 'mark met'
  if (waiting) return 'mark on'
  return 'mark'
}

function humanReviewClass(changes: boolean, mine: boolean, human: boolean, waiting: boolean) {
  if (changes) return 'mark changes'
  if (mine) return 'mark mine'
  if (human) return 'mark met'
  if (waiting) return 'mark on'
  return 'mark'
}

function humanReviewTitle(changes: boolean, mine: boolean, human: boolean, waiting: boolean) {
  if (changes) return 'Changes requested'
  if (mine) return 'Approved by you'
  if (human) return 'Approved by a person'
  if (waiting) return 'Awaiting a person'
  return 'No review requested'
}

function approvedBy(prs: PullRequest[], login: string | null): boolean {
  return prs.every((pr) => approvedByLogin(pr, login))
}

function ReviewControl({ id, prs, summary }: { id: string; prs: PullRequest[]; summary?: StackSummary }) {
  const viewer = useViewer()
  const any = summary?.anyApproval ?? prs[0]!.anyApproval
  const human = summary?.humanApproval ?? prs[0]!.humanApproval
  const mine = approvedBy(prs, viewer)
  const changes = summary?.changesRequested ?? prs[0]!.changesRequested
  const mark = summary?.mergeMark ?? prs[0]!.mergeMark
  const needed = mark === 'met' || mark === 'unmet'
  const { locked } = useStackLock()
  return (
    <HoverCard
      id={id}
      disabled={locked}
      className="marks"
      label={
        <>
          <span className="sr">Review</span>
          <i className={reviewClass(any, needed)} title={any ? 'Approved' : needed ? 'Awaiting approval' : 'No review requested'}>
            <CheckIcon />
          </i>
          <i className={humanReviewClass(changes, mine, human, needed)} title={humanReviewTitle(changes, mine, human, needed)}>
            <PersonIcon />
          </i>
          <i className={reviewClass(mark === 'met', mark === 'unmet')} title={mergeTitle(mark, changes)}>
            <MergeIcon />
          </i>
        </>
      }
    >
      <div>
        <h3>Reviews</h3>
        {prs.map((pr) => (
          <div key={pr.id} className="review-line">
            {prs.length > 1 ? <span className="review-num">#{pr.number}</span> : null}
            {pr.reviewers.length === 0 ? <span className="review-none">No reviews yet</span> : null}
            {pr.reviewers.map((reviewer) => (
              <span
                key={reviewer.login}
                className={`reviewer ${reviewer.state === 'APPROVED' ? 'approved' : 'changes'}`}
                title={`${reviewer.login}${reviewer.human ? '' : ' (bot)'}: ${reviewer.state === 'APPROVED' ? 'approved' : 'changes requested'}`}
              >
                {reviewer.avatarUrl ? (
                  <img src={reviewer.avatarUrl} alt="" />
                ) : (
                  <span className="avatar fallback" aria-hidden="true">
                    {reviewer.login.slice(0, 1).toUpperCase()}
                  </span>
                )}
                {reviewer.login}
                <span className="sr">{reviewer.state === 'APPROVED' ? ' approved' : ' requested changes'}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </HoverCard>
  )
}
