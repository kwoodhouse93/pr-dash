import { useMemo, useRef, type CSSProperties } from 'react'
import type { CheckHold } from '../shared/ci.ts'
import type { FeedbackCounts } from '../shared/feedback.ts'
import type { RowMark } from '../shared/queue.ts'
import type { AgentRouting, Initiative, PullRequest, Sort, SortKey, ListName } from '../shared/types.ts'
import { blockRails, type Bucket, LOOSE_SECTION, type Outline } from '../shared/view.ts'
import { AgentProvider, type StartAgent } from './agent-launch.tsx'
import { FeedbackProvider } from './feedback.tsx'
import { useChanged, useSlidingRows } from './motion.tsx'
import { COLUMNS, HoldContext, type IssuePatch, MotionContext, TableContext, type TableShared, UnapprovedMergeContext } from './table/context.tsx'
import { BucketRows, GroupToggle, ProjectRows, SectionBand } from './table/sections.tsx'
import { Icon } from './icons.tsx'

/** What a row shows of a pull request's state. When this changes, the row is washed warm for a moment. */
function rowSignature(pr: PullRequest): string {
  return [pr.ci, pr.awaitingYouCount, pr.commentAwaitingCount, pr.unreadCount, pr.resolvedUnreadCount, pr.reviewCommentAwaitingCount, pr.reviewDecision, pr.mergeMark, pr.conflict, pr.isDraft].join('|')
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
  onMergeUnapproved,
  onRetry,
  onStackMerge,
  onMarkReady,
  queueByKey,
  holds,
  onRerun,
  onStartAgent,
  agentRouting,
  t3Origin,
  onRebase,
  flat,
  onToggleFlat,
  onRefreshPr,
  linearConfigured,
  onUpdateIssue,
  onLinkIssue,
  viewer,
  onFeedback,
  leaving = NONE_LEAVING,
}: {
  mode: ListName
  outline: Outline
  sort: Sort
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  showRepo: boolean
  expanded: Set<string>
  collapsed: Set<string>
  onSort: (key: SortKey) => void
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  /** Left out, a pull request's menu does not offer to merge it without approval. */
  onMergeUnapproved?: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  queueByKey: Map<string, RowMark>
  holds: Map<string, CheckHold[]>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onStartAgent: StartAgent
  /** Which provider starts agents for each repository. Left out, Cursor starts them all. */
  agentRouting?: AgentRouting
  /** The T3 Code this browser is paired with, so its threads open in a tab. */
  t3Origin?: string | null
  onRebase: (key: string) => Promise<void>
  flat: ReadonlySet<string>
  onToggleFlat: (id: string) => void
  onRefreshPr: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: IssuePatch) => Promise<void>
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
  const table: TableShared = {
    mode,
    initiatives,
    prByKey,
    showRepo,
    linearConfigured,
    queueByKey,
    tones,
    expanded,
    collapsed,
    flat,
    onToggle,
    onToggleSection,
    onToggleFlat,
    onAssign,
    onCreateAssigned,
    onMerge,
    onRetry,
    onStackMerge,
    onMarkReady,
    onRerun,
    onRebase,
    onRefreshPr,
    onUpdateIssue,
    onLinkIssue,
  }
  return (
    <FeedbackProvider viewer={viewer} onCounts={onFeedback}>
    <AgentProvider start={onStartAgent} routing={agentRouting} t3Origin={t3Origin}>
    <UnapprovedMergeContext.Provider value={mode === 'mine' ? (onMergeUnapproved ?? null) : null}>
    <HoldContext.Provider value={holds}>
    <MotionContext.Provider value={motion}>
    <TableContext.Provider value={table}>
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
            <Icon name="robot" className="robot-icon" />
          </th>
          {mode === 'mine' ? <th className="merge">Merge</th> : null}
          <th className="open">Open</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody ref={body}>
        {outline.projects.length ? (
          <SectionBand id="band:projects" title="Linear projects">
            {outline.projects.map((project) => (
              <ProjectRows key={project.id} project={project} />
            ))}
          </SectionBand>
        ) : null}
        {outline.initiatives.length ? (
          <SectionBand id="band:initiatives" title="Initiatives">
            {outline.initiatives.map((bucket) => (
              <BucketRows key={bucket.id} bucket={bucket} depth={1} />
            ))}
          </SectionBand>
        ) : null}
        {outline.looseIssues.length ? (
          <SectionBand
            id={LOOSE_SECTION}
            title="Issues with no project"
            action={<GroupToggle id={LOOSE_SECTION} />}
          >
            {outline.looseIssues.map((bucket) => (
              <BucketRows key={bucket.id} bucket={bucket} depth={1} untitled={!bucket.title} />
            ))}
          </SectionBand>
        ) : null}
        {outline.unassigned ? (
          outline.projects.length > 0 || outline.initiatives.length > 0 || outline.looseIssues.length > 0 ? (
            <SectionBand id="band:unassigned" title="No issue">
              <BucketRows bucket={outline.unassigned} depth={1} untitled />
            </SectionBand>
          ) : (
            <BucketRows bucket={outline.unassigned} depth={1} untitled />
          )
        ) : null}
      </tbody>
    </table>
    </TableContext.Provider>
    </MotionContext.Provider>
    </HoldContext.Provider>
    </UnapprovedMergeContext.Provider>
    </AgentProvider>
    </FeedbackProvider>
  )
}

const NONE_LEAVING: Set<string> = new Set()

const SKELETON_TITLES = [62, 44, 71, 38, 56, 49, 66, 41]

/** The list while it loads: the table's own columns, with a bar where each value will be. */
export function SkeletonTable({ mode, note }: { mode: ListName; note: string }) {
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
            <th className="agents"><Icon name="robot" className="robot-icon" /></th>
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
