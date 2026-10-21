import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { activeHoldNames, checkPhase, checkStamp, ciDetail, ciLabel, compareChecks, displayCi, worstDisplay, type CheckHold, type CiDisplay } from '../shared/ci.ts'
import { cursorLinks, cursorStatusLabel, leadingCursorStatus } from '../shared/cursor.ts'
import { canMergeSlice, canSquashMerge } from '../shared/merge.ts'
import { stepLabel, type RowMark, type StepStatus } from '../shared/queue.ts'
import type { StackSummary } from '../shared/stacks.ts'
import type { Check, CursorSession, Initiative, LinearIssue, MergeMark, PullRequest, Sort, SortKey } from '../shared/types.ts'
import type { Bucket, Outline, ProjectGroup, StackBlock } from '../shared/view.ts'
import { TagEditor } from './editors.tsx'
import { formatCount, formatExact, formatWhen } from './format.ts'
import { isLinearIdentifier, IssueControls } from './issue-controls.tsx'
import { ClickCard, HoverCard, useMenuClose } from './menus.tsx'

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

const COLUMNS = 14

const HoldContext = createContext<Map<string, CheckHold[]>>(new Map())
const EMPTY_HOLDS: CheckHold[] = []

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
  repoColor,
  expanded,
  collapsed,
  onSort,
  onToggle,
  onToggleSection,
  onAssign,
  onCreateAssigned,
  onMerge,
  onQueue,
  onStackMerge,
  queueByKey,
  holds,
  onRerun,
  onResolveConflictWithCursor,
  onRebase,
  linearConfigured,
  onUpdateIssue,
}: {
  mode: 'mine' | 'review'
  outline: Outline
  sort: Sort
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  repoColor: Map<string, string>
  expanded: Set<string>
  collapsed: Set<string>
  onSort: (key: SortKey) => void
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  queueByKey: Map<string, RowMark>
  holds: Map<string, CheckHold[]>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onResolveConflictWithCursor: (key: string) => Promise<{ url: string }>
  onRebase: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const tones = stackTones(outline)
  const shared = {
    mode,
    namesList: initiatives,
    prByKey,
    repoColor,
    tones,
    expanded,
    collapsed,
    onToggle,
    onToggleSection,
    onAssign,
    onCreateAssigned,
    onMerge,
    onQueue,
    onStackMerge,
    queueByKey,
    onRerun,
    onResolveConflictWithCursor,
    onRebase,
    linearConfigured,
    onUpdateIssue,
  }
  return (
    <HoldContext.Provider value={holds}>
    <table className="prs">
      <thead>
        <tr>
          <th className="grip" aria-label="Stack" />
          <th className="num">#</th>
          <SortHeader label="Title" sortKey="title" sort={sort} onSort={onSort} />
          {mode === 'review' ? <th className="author">Author</th> : null}
          <SortHeader label="Repo" sortKey="repo" sort={sort} onSort={onSort} />
          <SortHeader label="Size" sortKey="size" sort={sort} onSort={onSort} />
          <SortHeader label="Created" sortKey="created" sort={sort} onSort={onSort} />
          <SortHeader label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
          <SortHeader label="CI" sortKey="ci" sort={sort} onSort={onSort} />
          <th className="conflict">Conflict</th>
          <th className="uptodate">Up-to-date</th>
          <th>Review</th>
          <th>Feedback</th>
          {mode === 'mine' ? <th className="merge">Merge</th> : null}
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {outline.projects.length ? <Band title="Linear projects" /> : null}
        {outline.projects.map((project) => (
          <ProjectRows key={project.id} project={project} {...shared} />
        ))}
        {outline.initiatives.length ? <Band title="Initiatives" /> : null}
        {outline.initiatives.map((bucket) => (
          <BucketRows key={bucket.id} bucket={bucket} depth={1} {...shared} />
        ))}
        {outline.looseIssues.length ? <Band title="Issues with no project" /> : null}
        {outline.looseIssues.map((bucket) => (
          <BucketRows key={bucket.id} bucket={bucket} depth={1} {...shared} />
        ))}
        {outline.unassigned ? (
          <>
            <Band title="No issue" />
            <BucketRows bucket={outline.unassigned} depth={1} untitled {...shared} />
          </>
        ) : null}
      </tbody>
    </table>
    </HoldContext.Provider>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string
  sortKey: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th>
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
  repoColor: Map<string, string>
  tones: Map<string, 'a' | 'b'>
  expanded: Set<string>
  collapsed: Set<string>
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  queueByKey: Map<string, RowMark>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onResolveConflictWithCursor: (key: string) => Promise<{ url: string }>
  onRebase: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}

function Band({ title }: { title: string }) {
  return (
    <tr className="band">
      <td colSpan={COLUMNS}>
        <span className="section-title">{title}</span>
      </td>
    </tr>
  )
}

function ProjectRows({ project, ...shared }: { project: ProjectGroup } & RowShared) {
  const count = project.issues.reduce((total, issue) => total + issue.count, 0)
  const open = !shared.collapsed.has(project.id)
  return (
    <>
      <tr className="project depth-1 fold" onClick={(event) => toggleSection(event, () => shared.onToggleSection(project.id))}>
        <td colSpan={COLUMNS}>
          <SectionHead open={open} label={project.title} onToggle={() => shared.onToggleSection(project.id)}>
            <span className="section-title">{project.title}</span>
            <span className="section-meta">{count === 1 ? '1 pull request' : `${count} pull requests`}</span>
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
        <tr className={`section depth-${depth} fold`} onClick={(event) => toggleSection(event, () => shared.onToggleSection(bucket.id))}>
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

function toggleSection(event: { target: EventTarget | null }, toggle: () => void) {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('button, a, input, label')) return
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
  const visible = block.rows.flatMap((row) => (row.type === 'pr' ? [row.pr] : []))
  const stackTone = block.collapsible ? tone : null
  const rows =
    !block.collapsible || open ? (
      block.rows.map((row, index) => {
      const spine = stackTone ? spineAt(index, block.rows.length) : null
      return row.type === 'ellipsis' ? (
        <tr key={row.id} className={`ellipsis${spineClass(spine, stackTone)}`}>
          <td className="grip" />
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
          block={block}
          child={block.collapsible}
          spine={spine}
          tone={stackTone}
          toggle={block.collapsible && row.pr.id === visible[0]?.id ? { id: openId, open, onToggle: shared.onToggle } : null}
          hideIssue={bucket.issueId ?? undefined}
          initiatives={shared.namesList}
          prByKey={shared.prByKey}
          repoColor={shared.repoColor}
          linearConfigured={shared.linearConfigured}
          onAssign={shared.onAssign}
          onCreateAssigned={shared.onCreateAssigned}
          onMerge={shared.onMerge}
          onQueue={shared.onQueue}
          onStackMerge={shared.onStackMerge}
          queueByKey={shared.queueByKey}
          onRerun={shared.onRerun}
          onResolveConflictWithCursor={shared.onResolveConflictWithCursor}
          onRebase={shared.onRebase}
          onUpdateIssue={shared.onUpdateIssue}
        />
      )
    })
  ) : (
    <SummaryRow
      key={block.id}
      mode={shared.mode}
      block={block}
      visible={visible}
      openId={openId}
      spine="only"
      tone={stackTone}
      hideIssue={bucket.issueId ?? undefined}
      initiatives={shared.namesList}
      prByKey={shared.prByKey}
      repoColor={shared.repoColor}
      linearConfigured={shared.linearConfigured}
      onToggle={shared.onToggle}
      onAssign={shared.onAssign}
      onCreateAssigned={shared.onCreateAssigned}
      onRerun={shared.onRerun}
      onResolveConflictWithCursor={shared.onResolveConflictWithCursor}
      onRebase={shared.onRebase}
      onUpdateIssue={shared.onUpdateIssue}
      onMerge={shared.onMerge}
      onQueue={shared.onQueue}
      onStackMerge={shared.onStackMerge}
      queueByKey={shared.queueByKey}
    />
    )
  return <StackLockContext.Provider value={stackLock}>{rows}</StackLockContext.Provider>
}

function DataRow({
  mode,
  pr,
  block,
  child,
  spine,
  tone,
  toggle,
  initiatives,
  prByKey,
  repoColor,
  hideIssue,
  linearConfigured,
  onAssign,
  onCreateAssigned,
  onMerge,
  onQueue,
  onStackMerge,
  queueByKey,
  onRerun,
  onResolveConflictWithCursor,
  onRebase,
  onUpdateIssue,
}: {
  mode: 'mine' | 'review'
  pr: PullRequest
  block: StackBlock
  child: boolean
  spine: Spine | null
  tone: 'a' | 'b' | null
  toggle: { id: string; open: boolean; onToggle: (id: string) => void } | null
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  repoColor: Map<string, string>
  hideIssue?: string
  linearConfigured: boolean
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  queueByKey: Map<string, RowMark>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onResolveConflictWithCursor: (key: string) => Promise<{ url: string }>
  onRebase: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const holds = useHolds()
  const { locked } = useStackLock()
  const mark = queueByKey.get(pr.key) ?? null
  const ci = shownLevel([pr], holds)
  return (
    <tr
      className={`${child ? 'child' : ''} ${ci === 'red' ? 'fail' : ''} ${toggle ? 'stack' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}`}
      onClick={(event) => {
        if (!toggle) return
        if ((event.target as HTMLElement).closest('button, a, input, label')) return
        toggle.onToggle(toggle.id)
      }}
    >
      <Grip spine={spine} />
      <td className="num">
        <a href={pr.url} target="_blank" rel="noreferrer">
          {pr.number}
        </a>
      </td>
      <td className="title-block">
        <div className="title-line">
          {pr.isDraft ? <span className="pill draft">Draft</span> : null}
          <a href={pr.url} target="_blank" rel="noreferrer">
            {pr.title}
          </a>
        </div>
        <Subline
          menuScope={pr.id}
          issues={pr.linearIssues.filter((issue) => issue.identifier !== hideIssue)}
          linearConfigured={linearConfigured}
          onUpdateIssue={onUpdateIssue}
        />
      </td>
      {mode === 'review' ? (
        <td className="author">
          <Authors people={[{ login: pr.author, avatarUrl: pr.authorAvatarUrl ?? null }]} />
        </td>
      ) : null}
      <td className="repo" title={pr.repo}>
        <i className="pip" style={{ background: repoColor.get(pr.repo) }} />
        {pr.repoName}
      </td>
      <Size additions={pr.additions} deletions={pr.deletions} files={pr.changedFiles} />
      <When iso={pr.createdAt} />
      <When iso={pr.updatedAt} />
      <td>
        <CiControl id={`ci:${pr.id}`} prs={[pr]} onRerun={onRerun} />
      </td>
      <Conflict id={`conflict:${pr.id}`} prs={[pr]} onResolveWithCursor={onResolveConflictWithCursor} />
      <UpToDate id={`uptodate:${pr.id}`} targetKey={pr.behind ? pr.key : null} stackKeys={block.stackKeys} prByKey={prByKey} onRebase={onRebase} />
      <td>
        <ReviewControl id={`review:${pr.id}`} prs={[pr]} />
      </td>
      <td>
        <Feedback
          mode={mode}
          threads={pr.threadCount}
          unresolved={pr.unresolvedCount}
          awaiting={pr.awaitingYouCount ?? 0}
          unread={pr.unreadCount ?? 0}
          resolvedUnread={pr.resolvedUnreadCount ?? 0}
          comments={pr.commentAwaitingCount ?? 0}
          reviewComments={pr.reviewCommentAwaitingCount ?? 0}
          truncated={pr.threadsTruncated}
        />
      </td>
      {mode === 'mine' ? (
        <td className="merge">
          <MergeControls
            pr={pr}
            ordered={orderedStack(block, prByKey)}
            mark={mark}
            onMerge={onMerge}
            onQueue={onQueue}
            onStackMerge={onStackMerge}
          />
        </td>
      ) : null}
      <RowMenu
        id={`menu:${pr.id}`}
        primaryKey={pr.key}
        stackKeys={block.stackKeys}
        defaultWholeStack={false}
        initiatives={initiatives}
        prByKey={prByKey}
        onAssign={onAssign}
        onCreate={onCreateAssigned}
      />
    </tr>
  )
}

function SummaryRow({
  mode,
  block,
  visible,
  openId,
  spine,
  tone,
  initiatives,
  prByKey,
  repoColor,
  hideIssue,
  linearConfigured,
  onToggle,
  onAssign,
  onCreateAssigned,
  onRerun,
  onResolveConflictWithCursor,
  onRebase,
  onUpdateIssue,
  onMerge,
  onQueue,
  onStackMerge,
  queueByKey,
}: {
  mode: 'mine' | 'review'
  block: StackBlock
  visible: PullRequest[]
  openId: string
  spine: Spine
  tone: 'a' | 'b' | null
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  repoColor: Map<string, string>
  hideIssue?: string
  linearConfigured: boolean
  onToggle: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onResolveConflictWithCursor: (key: string) => Promise<{ url: string }>
  onRebase: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  queueByKey: Map<string, RowMark>
}) {
  const holds = useHolds()
  const summary = block.summary
  const ci = shownLevel(visible, holds)
  const issues = sharedIssues(visible, hideIssue)
  const ordered = orderedStack(block, prByKey)
  const mark = foremost(block.stackKeys, queueByKey)
  const top = ordered[0] ?? null
  const { locked } = useStackLock()
  return (
    <tr
      className={`stack ${ci === 'red' ? 'fail' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, a, input, label')) return
        onToggle(openId)
      }}
    >
      <Grip spine={spine} />
      <td className="num">
        <a href={summary.url} target="_blank" rel="noreferrer">
          {summary.number}
        </a>
      </td>
      <td className="title-block">
        <div className="title-line">
          {summary.draftCount > 0 ? (
            <span className="pill draft">{summary.draftCount === visible.length ? 'Draft' : `${summary.draftCount} draft`}</span>
          ) : null}
          <a href={summary.url} target="_blank" rel="noreferrer">
            {summary.title}
          </a>
          {summary.extra > 0 ? <span className="pill">+{summary.extra}</span> : null}
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
      <td className="repo" title={summary.repo}>
        <i className="pip" style={{ background: repoColor.get(summary.repo) }} />
        {summary.repoName}
      </td>
      <Size additions={summary.additions} deletions={summary.deletions} files={summary.changedFiles} />
      <When iso={summary.createdAt} />
      <When iso={summary.updatedAt} />
      <td>
        <CiControl id={`ci:${block.id}`} prs={visible} onRerun={onRerun} />
      </td>
      <Conflict id={`conflict:${block.id}`} prs={visible} onResolveWithCursor={onResolveConflictWithCursor} />
      <UpToDate
        id={`uptodate:${block.id}`}
        targetKey={lowestBehindKey(block.stackKeys, visible)}
        stackKeys={block.stackKeys}
        prByKey={prByKey}
        onRebase={onRebase}
      />
      <td>
        <ReviewControl id={`review:${block.id}`} prs={visible} summary={summary} />
      </td>
      <td>
        <Feedback
          mode={mode}
          threads={summary.threadCount}
          unresolved={summary.unresolvedCount}
          awaiting={summary.awaitingYouCount ?? 0}
          unread={summary.unreadCount ?? 0}
          resolvedUnread={summary.resolvedUnreadCount ?? 0}
          comments={summary.commentAwaitingCount ?? 0}
          reviewComments={summary.reviewCommentAwaitingCount ?? 0}
          truncated={false}
        />
      </td>
      {mode === 'mine' ? (
      <td className="merge">
        {top && !summary.partial ? (
          <MergeControls
            pr={top}
            ordered={ordered}
            mark={mark}
            progress
            onMerge={onMerge}
            onQueue={onQueue}
            onStackMerge={onStackMerge}
          />
        ) : mark ? (
          <QueueStatus mark={mark} progress />
        ) : null}
      </td>
      ) : null}
      <RowMenu
        id={`menu:${block.id}`}
        primaryKey={summary.topKey}
        stackKeys={block.stackKeys}
        defaultWholeStack
        initiatives={initiatives}
        prByKey={prByKey}
        onAssign={onAssign}
        onCreate={onCreateAssigned}
      />
    </tr>
  )
}

function Grip({ spine }: { spine: Spine | null }) {
  return (
    <td className="grip">
      {spine === 'only' ? <span className="stack-mark" aria-hidden="true" /> : null}
    </td>
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

function sharedIssues(prs: PullRequest[], hideIssue?: string): LinearIssue[] {
  const issues = prs.flatMap((pr) => pr.linearIssues).filter((issue) => issue.identifier !== hideIssue)
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

function Conflict({
  id,
  prs,
  onResolveWithCursor,
}: {
  id: string
  prs: PullRequest[]
  onResolveWithCursor: (key: string) => Promise<{ url: string }>
}) {
  const conflicts = prs.filter((pr) => pr.conflict)
  const sessions = prs.flatMap((pr) => (pr.cursorSession ? [{ pr, session: pr.cursorSession }] : []))
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { locked } = useStackLock()

  async function resolve(pr: PullRequest) {
    setError(null)
    setPending(pr.key)
    const agent = window.open('', '_blank')
    if (agent) agent.opener = null
    try {
      const result = await onResolveWithCursor(pr.key)
      if (agent) agent.location.href = result.url
      else setError('Cursor started, but the new tab was blocked. Allow pop-ups and try again.')
    } catch (caught) {
      agent?.close()
      setError(caught instanceof Error ? caught.message : 'Could not start Cursor.')
    } finally {
      setPending(null)
    }
  }

  return (
    <td className="conflict">
      <span className="conflict-cell">
        {conflicts.length ? (
          <ClickCard
            id={id}
            className="conflict-x"
            disabled={locked}
            label={
              <>
                <span className="sr">Resolve merge conflict with Cursor</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </>
            }
          >
            <h3>Resolve with Cursor</h3>
            <p>Cursor will resolve the conflict and push to this pull request’s existing branch.</p>
            {conflicts.map((pr) => (
              <button key={pr.key} type="button" className="menu-item" disabled={locked || pending !== null} onClick={() => void resolve(pr)}>
                {pending === pr.key ? 'Starting Cursor…' : `#${pr.number} · ${pr.title}`}
              </button>
            ))}
            {error ? <p className="launch-error">{error}</p> : null}
          </ClickCard>
        ) : null}
        {sessions.length ? <CursorChip id={`${id}:cursor`} sessions={sessions} /> : null}
        {conflicts.length === 0 && sessions.length === 0 ? <span className="sr">No conflict</span> : null}
      </span>
    </td>
  )
}

function UpToDate({
  id,
  targetKey,
  stackKeys,
  prByKey,
  onRebase,
}: {
  id: string
  targetKey: string | null
  stackKeys: string[]
  prByKey: Map<string, PullRequest>
  onRebase: (key: string) => Promise<void>
}) {
  const plan = targetKey ? rebasePlan(stackKeys, targetKey, prByKey) : null
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
  targetKey: string,
  prByKey: Map<string, PullRequest>,
): { target: PullRequest; above: PullRequest[] } | null {
  const target = prByKey.get(targetKey)
  if (!target) return null
  const index = stackKeys.indexOf(targetKey)
  const above =
    index < 0
      ? []
      : stackKeys
          .slice(0, index)
          .reverse()
          .flatMap((key) => {
            const pr = prByKey.get(key)
            return pr ? [pr] : []
          })
  return { target, above }
}

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

function CursorChip({
  id,
  sessions,
}: {
  id: string
  sessions: { pr: PullRequest; session: CursorSession }[]
}) {
  const lead = leadingCursorStatus(sessions.map((item) => item.session.status)) ?? 'running'
  const { locked } = useStackLock()
  return (
    <ClickCard
      id={id}
      disabled={locked}
      className={`cursor-chip ${lead}`}
      label={
        <>
          <span className="sr">Cursor session {cursorStatusLabel(lead)}</span>
          {cursorStatusLabel(lead)}
        </>
      }
    >
      {sessions.map(({ pr, session }) => {
        const links = cursorLinks(session.agentId)
        return (
          <div key={pr.key} className="cursor-session">
            <h3>
              {sessions.length > 1 ? `#${pr.number} · ` : ''}
              {cursorStatusLabel(session.status)}
            </h3>
            <p>{cursorStatusDetail(session)}</p>
            {session.branch ? <p>Pushed to {session.branch}.</p> : null}
            {session.result ? <p className="cursor-result">{session.result}</p> : null}
            <div className="cursor-links">
              <a href={links.desktopUrl}>Open in Cursor</a>
              <a href={links.webUrl} target="_blank" rel="noreferrer">
                Open on the web
              </a>
            </div>
          </div>
        )
      })}
    </ClickCard>
  )
}

function cursorStatusDetail(session: CursorSession): string {
  switch (session.status) {
    case 'creating':
      return 'Cursor is starting a cloud agent for this conflict.'
    case 'running':
      return 'Cursor is resolving the conflict on this pull request.'
    case 'finished':
      return 'Cursor finished this run.'
    case 'failed':
      return 'Cursor reported a failed run.'
    case 'cancelled':
      return 'This Cursor run was cancelled.'
    case 'expired':
      return 'This Cursor run expired.'
  }
}

function RowMenu(props: {
  id: string
  primaryKey: string
  stackKeys: string[]
  defaultWholeStack: boolean
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreate: (name: string, keys: string[]) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const { locked } = useStackLock()
  return (
    <td className="row-actions">
      <ClickCard
        id={props.id}
        className="row-menu"
        disabled={locked}
        label={
          <>
            <span className="sr">Row actions</span>
            <span aria-hidden="true">⋯</span>
          </>
        }
      >
        {editing ? (
          <TagEditor
            primaryKey={props.primaryKey}
            stackKeys={props.stackKeys}
            defaultWholeStack={props.defaultWholeStack}
            prByKey={props.prByKey}
            initiatives={props.initiatives}
            onAssign={props.onAssign}
            onCreate={props.onCreate}
          />
        ) : (
          <button type="button" className="menu-item" onClick={() => setEditing(true)}>
            Set initiative
          </button>
        )}
      </ClickCard>
    </td>
  )
}

function Size({ additions, deletions, files }: { additions: number; deletions: number; files: number }) {
  return (
    <td className="size">
      <span className="add">+{formatCount(additions)}</span>
      <span className="del">−{formatCount(deletions)}</span>
      <span className="files">{formatCount(files)} {files === 1 ? 'file' : 'files'}</span>
    </td>
  )
}

function When({ iso }: { iso: string }) {
  return (
    <td className="when" title={formatExact(iso)}>
      {formatWhen(iso)}
    </td>
  )
}

function orderedStack(block: StackBlock, prByKey: Map<string, PullRequest>): PullRequest[] {
  const prs = block.stackKeys.map((key) => prByKey.get(key)).filter((pr): pr is PullRequest => pr != null)
  return prs.length === block.stackKeys.length ? prs : []
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
  progress = false,
  onMerge,
  onQueue,
  onStackMerge,
}: {
  pr: PullRequest
  ordered: PullRequest[]
  mark: RowMark | null
  progress?: boolean
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
}) {
  if (mark) return <QueueStatus mark={mark} progress={progress} />
  const count = canMergeSlice(ordered, pr.key)
  if (count != null) return <StackMergeButton count={count} pr={pr} onStackMerge={onStackMerge} />
  if (canSquashMerge(pr)) return <SplitMerge pr={pr} onMerge={onMerge} onQueue={onQueue} />
  return null
}

function QueueStatus({ mark, progress }: { mark: RowMark; progress: boolean }) {
  const text = progress && mark.total > 1 ? `${stepLabel(mark.status)} · ${mark.done} of ${mark.total}` : stepLabel(mark.status)
  return (
    <div className="merge-action">
      <span className={`pill queue ${mark.status}`}>{text}</span>
      {mark.status === 'failed' && mark.detail ? <p className="merge-error">{mark.detail}</p> : null}
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

function SplitMerge({
  pr,
  onMerge,
  onQueue,
}: {
  pr: PullRequest
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
}) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { locked } = useStackLock()
  const busy = pending || locked
  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])
  return (
    <div className="merge-action">
      <div className="split-merge">
        <button
          type="button"
          className="primary merge"
          disabled={busy}
          aria-busy={busy}
          aria-label={pending ? `Merging #${pr.number}` : `Squash and merge #${pr.number}`}
          onClick={() => {
            if (pendingRef.current || locked) return
            pendingRef.current = true
            setPending(true)
            setError(null)
            void onMerge(pr.key).catch((caught: unknown) => {
              pendingRef.current = false
              setPending(false)
              setError(caught instanceof Error ? caught.message : 'Merge failed')
            })
          }}
        >
          {pending ? 'Merging' : 'Merge'}
        </button>
        <button
          ref={anchor}
          type="button"
          className="primary merge caret"
          aria-expanded={open}
          aria-label={`More merge actions for #${pr.number}`}
          disabled={busy}
          onClick={() => setOpen((current) => !current)}
        >
          ▾
        </button>
      </div>
      {open && anchor.current ? (
        <QueueMenu
          anchor={anchor.current}
          onClose={() => setOpen(false)}
          onQueue={() => {
            setOpen(false)
            setError(null)
            void onQueue(pr.key).catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : 'Could not queue that pull request')
            })
          }}
        />
      ) : null}
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function QueueMenu({ anchor, onQueue, onClose }: { anchor: HTMLElement; onQueue: () => void; onClose: () => void }) {
  const rect = anchor.getBoundingClientRect()
  const menuHeight = 44
  const below = rect.bottom + 6
  const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 6) : below
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && anchor.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  return createPortal(
    <div className="popover merge-menu" style={{ top, left: Math.max(12, rect.right - 168) }} role="menu">
      <button type="button" className="menu-item" role="menuitem" onClick={onQueue}>
        Queue
      </button>
    </div>,
    document.body,
  )
}

function Feedback({
  mode,
  threads,
  unresolved,
  awaiting,
  unread,
  resolvedUnread,
  comments,
  reviewComments,
  truncated,
}: {
  mode: 'mine' | 'review'
  threads: number
  unresolved: number
  awaiting: number
  unread: number
  resolvedUnread: number
  comments: number
  reviewComments: number
  truncated: boolean
}) {
  const parts: { key: string; text: string; hot: boolean }[] = []
  const commentText = (count: number) => `${count} comment${count === 1 ? '' : 's'}`
  if (mode === 'review') {
    if (unread > 0) parts.push({ key: 'unread', text: `${unread} unread`, hot: true })
    if (reviewComments > 0) parts.push({ key: 'review-comments', text: commentText(reviewComments), hot: true })
    const otherComments = comments - reviewComments
    if (reviewComments === 0 && comments > 0) parts.push({ key: 'comments', text: commentText(comments), hot: false })
    else if (otherComments > 0) parts.push({ key: 'comments', text: `${otherComments} other`, hot: false })
    if (resolvedUnread > 0) parts.push({ key: 'resolved', text: `${resolvedUnread} resolved unread`, hot: false })
  } else {
    if (awaiting > 0) parts.push({ key: 'awaiting', text: `${awaiting} awaiting`, hot: true })
    if (comments > 0) parts.push({ key: 'comments', text: commentText(comments), hot: true })
  }
  if (unresolved > 0) parts.push({ key: 'unresolved', text: `${unresolved} unresolved`, hot: false })
  if (threads > 0 || parts.length === 0) {
    parts.push({
      key: 'threads',
      text: `${threads}${truncated ? '+' : ''} thread${threads === 1 ? '' : 's'}`,
      hot: false,
    })
  }
  const title = mode === 'review'
    ? 'Unread is an open thread you joined that has a newer reply. A highlighted comment is a review message, or a conversation you joined, that you have not answered. Other comments are conversation notes you have not joined. Resolved unread is a thread you joined that was resolved, or replied to, after you last spoke.'
    : 'Awaiting you is an open thread whose latest human comment is not yours. A comment is a conversation comment or review message you have not answered.'
  return (
    <span className="feedback" title={title}>
      {parts.map((part, index) => (
        <span key={part.key}>
          {index > 0 ? <span className="dot">·</span> : null}
          {part.hot ? <em className="await">{part.text}</em> : <span>{part.text}</span>}
        </span>
      ))}
    </span>
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
  const checks = prs.flatMap((pr) => pr.checks.map((check) => ({ pr, check })))
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
  const heading = level === 'invalidated' ? ciDetail(level) : prs.length === 1 ? ciDetail(prs[0]!.ci) : 'Checks across this stack'
  return (
    <div>
      <h3>{heading}</h3>
      <RerunActions keys={prs.map((pr) => pr.key)} onRerun={onRerun} />
      {[...grouped.entries()].map(([workflow, items]) => (
        <div key={workflow} className="check-group">
          <h4>{workflow}</h4>
          {items.map(({ pr, check }) => {
            const phase = checkPhase(check)
            const stale = invalidated(pr, check)
            const tone = stale ? 'invalidated' : phase === 'fail' ? 'fail' : phase === 'pending' ? 'pending' : 'success'
            const state = stale ? 'Invalidated' : phase === 'fail' ? 'Failed' : phase === 'pending' ? 'Running' : null
            return (
              <div key={`${pr.id}:${check.name}`} className="check">
                <i className={tone} />
                <span>
                  {prs.length > 1 ? `#${pr.number} ` : ''}
                  {check.url ? (
                    <a href={check.url} target="_blank" rel="noreferrer">
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

function ReviewControl({ id, prs, summary }: { id: string; prs: PullRequest[]; summary?: StackSummary }) {
  const any = summary?.anyApproval ?? prs[0]!.anyApproval
  const human = summary?.humanApproval ?? prs[0]!.humanApproval
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
          <i className={reviewClass(human, needed)} title={human ? 'Approved by a person' : needed ? 'Awaiting a person' : 'No review requested'}>
            <PersonIcon />
          </i>
          <i className={reviewClass(mark === 'met', mark === 'unmet')} title={mergeTitle(mark, changes)}>
            <MergeIcon />
          </i>
        </>
      }
    >
      <div>
        <h3>Review</h3>
        <p>{summary?.mergeDetail ?? prs[0]!.mergeDetail}</p>
        {prs.flatMap((pr) => pr.reviewers).length === 0 ? <p>No approving or changes-requested reviews.</p> : null}
        {prs.map((pr) =>
          pr.reviewers.map((reviewer) => (
            <div key={`${pr.id}:${reviewer.login}`} className="reviewer">
              <strong>
                {prs.length > 1 ? `#${pr.number} ` : ''}
                {reviewer.login}
                {reviewer.human ? '' : ' (bot)'}
              </strong>
              <span>{reviewer.state === 'APPROVED' ? 'Approved' : 'Changes'}</span>
            </div>
          )),
        )}
        <p>Grey means no review is required. White is still waiting. Green means that mark is satisfied. The check is any approval, the person is a human approval, and the arrow is GitHub’s merge requirement.</p>
      </div>
    </HoverCard>
  )
}
