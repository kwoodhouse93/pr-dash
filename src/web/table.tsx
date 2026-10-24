import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { activeHoldNames, checkPhase, checkStamp, ciDetail, ciLabel, compareChecks, displayCi, worstDisplay, type CheckHold, type CiDisplay } from '../shared/ci.ts'
import { activeSession, agentKindLabel, agentWork, failingChecks, PROMPT_LIMIT, type AgentRequest } from '../shared/agents.ts'
import { approvedByLogin } from '../shared/approval.ts'
import { cursorLinks, cursorSessionActive, cursorStatusLabel, leadingCursorStatus } from '../shared/cursor.ts'
import { canMergeSlice, canSquashMerge, sliceParts } from '../shared/merge.ts'
import { stepLabel, type MergeWatch, type RowMark, type StepStatus } from '../shared/queue.ts'
import type { StackSummary } from '../shared/stacks.ts'
import type { Check, CursorSession, Initiative, LinearIssue, MergeMark, PullRequest, Sort, SortKey } from '../shared/types.ts'
import type { Bucket, Outline, ProjectGroup, StackBlock } from '../shared/view.ts'
import { AgentProvider, launchTag, useAgentLaunch, type StartAgent } from './agent-launch.tsx'
import { TagEditor } from './editors.tsx'
import { formatCount, formatExact, formatWhen, graphitePrUrl } from './format.ts'
import { usePrHref } from './pr-links.tsx'
import { isLinearIdentifier, IssueControls, LinkIssueForm } from './issue-controls.tsx'
import type { FeedbackCounts } from '../shared/feedback.ts'
import { Feedback, FeedbackProvider, feedbackTarget, useViewer } from './feedback.tsx'
import { Markdown } from './markdown.tsx'
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

const COLUMNS = 18

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
  onMarkReady,
  onSetMergeWhenReady,
  queueByKey,
  watchesByKey,
  holds,
  onRerun,
  onStartAgent,
  onRebase,
  byIssue,
  onRefreshPr,
  linearConfigured,
  onUpdateIssue,
  onLinkIssue,
  viewer,
  onFeedback,
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
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
  queueByKey: Map<string, RowMark>
  watchesByKey: Map<string, MergeWatch>
  holds: Map<string, CheckHold[]>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onStartAgent: StartAgent
  onRebase: (key: string) => Promise<void>
  byIssue: boolean
  onRefreshPr: (key: string) => Promise<void>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
  viewer: string | null
  onFeedback: (key: string, counts: FeedbackCounts) => void
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
    <AgentProvider start={onStartAgent}>
    <HoldContext.Provider value={holds}>
    <table className="prs">
      <thead>
        <tr>
          <th className="grip" aria-label="Stack" />
          <th className="num">#</th>
          <SortHeader label="Title" sortKey="title" sort={sort} onSort={onSort} />
          {mode === 'review' ? <th className="author">Author</th> : null}
          <SortHeader className="repo" label="Repo" sortKey="repo" sort={sort} onSort={onSort} />
          <SortHeader className="size" colSpan={3} label="Size" sortKey="size" sort={sort} onSort={onSort} />
          <SortHeader className="when" label="Created" sortKey="created" sort={sort} onSort={onSort} />
          <SortHeader className="when" label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
          <SortHeader label="CI" sortKey="ci" sort={sort} onSort={onSort} />
          <th className="uptodate">Up-to-date</th>
          <th className="conflict">Conflict</th>
          <th>Review</th>
          <th>Feedback</th>
          <th className="agents">Agents</th>
          {mode === 'mine' ? <th className="merge">Merge</th> : null}
          <th className="open">Open</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
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
    </HoldContext.Provider>
    </AgentProvider>
    </FeedbackProvider>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  colSpan,
}: {
  label: string
  sortKey: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  className?: string
  colSpan?: number
}) {
  const active = sort.key === sortKey
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th className={className} colSpan={colSpan}>
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
      <tr className="band fold" onClick={(event) => toggleSection(event, () => onToggle(id))}>
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
      onRebase={shared.onRebase}
      onRefreshPr={shared.onRefreshPr}
      onUpdateIssue={shared.onUpdateIssue}
      onLinkIssue={shared.onLinkIssue}
      onMerge={shared.onMerge}
      onQueue={shared.onQueue}
      onStackMerge={shared.onStackMerge}
      onMarkReady={shared.onMarkReady}
      onSetMergeWhenReady={shared.onSetMergeWhenReady}
      queueByKey={shared.queueByKey}
      watchesByKey={shared.watchesByKey}
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
  return (
    <tr
      className={`${child ? 'child' : ''} ${ci === 'red' ? 'fail' : ''} ${toggle ? 'stack' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}`}
      onClick={(event) => {
        if (!toggle) return
        if (pressedControl(event.target)) return
        toggle.onToggle(toggle.id)
      }}
    >
      <Grip spine={spine} />
      <td className="num">
        <a href={prHref} target="_blank" rel="noreferrer">
          {pr.number}
        </a>
      </td>
      <td className="title-block">
        <div className="title-line">
          {pr.isDraft ? <span className="pill draft">Draft</span> : null}
          <a href={prHref} target="_blank" rel="noreferrer">
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
      <UpToDate id={`uptodate:${pr.id}`} targetKey={pr.behind ? pr.key : null} stackKeys={block.stackKeys} prByKey={prByKey} onRebase={onRebase} />
      <Conflict id={`conflict:${pr.id}`} prs={[pr]} />
      <td>
        <ReviewControl id={`review:${pr.id}`} prs={[pr]} />
      </td>
      <td>
        <Feedback mode={mode} targets={[feedbackTarget(pr)]} />
      </td>
      <Agents id={`agents:${pr.id}`} prs={[pr]} />
      {mode === 'mine' ? (
        <td className="merge">
          <MergeControls
            pr={pr}
            ordered={orderedStack(block, prByKey)}
            mark={mark}
            onMerge={onMerge}
            onQueue={onQueue}
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
  onRebase,
  onRefreshPr,
  onUpdateIssue,
  onLinkIssue,
  onMerge,
  onQueue,
  onStackMerge,
  onMarkReady,
  onSetMergeWhenReady,
  queueByKey,
  watchesByKey,
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
  onRebase: (key: string) => Promise<void>
  onRefreshPr: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onQueue: (key: string) => Promise<void>
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
  const ordered = orderedStack(block, prByKey)
  const mark = foremost(block.stackKeys, queueByKey)
  const top = ordered[0] ?? null
  const { locked } = useStackLock()
  return (
    <tr
      className={`stack ${ci === 'red' ? 'fail' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}`}
      onClick={(event) => {
        if (pressedControl(event.target)) return
        onToggle(openId)
      }}
    >
      <Grip spine={spine} />
      <td className="num">
        <a href={summaryHref} target="_blank" rel="noreferrer">
          {summary.number}
        </a>
      </td>
      <td className="title-block">
        <div className="title-line">
          {summary.draftCount > 0 ? (
            <span className="pill draft">{summary.draftCount === visible.length ? 'Draft' : `${summary.draftCount} draft`}</span>
          ) : null}
          <a href={summaryHref} target="_blank" rel="noreferrer">
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
      <UpToDate
        id={`uptodate:${block.id}`}
        targetKey={lowestBehindKey(block.stackKeys, visible)}
        stackKeys={block.stackKeys}
        prByKey={prByKey}
        onRebase={onRebase}
      />
      <Conflict id={`conflict:${block.id}`} prs={visible} />
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
            onQueue={onQueue}
            onStackMerge={onStackMerge}
            onMarkReady={onMarkReady}
            watch={watchesByKey.get(top.key) ?? null}
            onSetMergeWhenReady={onSetMergeWhenReady}
          />
        ) : mark ? (
          <QueueStatus mark={mark} progress />
        ) : null}
      </td>
      ) : null}
      <OpenLinks url={summary.url} repo={summary.repo} number={summary.number} />
      <RowMenu
        id={`menu:${block.id}`}
        primaryKey={summary.topKey}
        prs={visible}
        stackKeys={block.stackKeys}
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

function Grip({ spine }: { spine: Spine | null }) {
  return (
    <td className="grip">
      {spine === 'only' ? <span className="stack-mark" aria-hidden="true" /> : null}
    </td>
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
              <span className="sr">Resolve merge conflict with Cursor</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </>
          }
        >
          <h3>Resolve with Cursor</h3>
          <p>Cursor will resolve the conflict and push to this pull request’s existing branch.</p>
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
                    aria-label={conflicts.length > 1 ? `Resolve #${pr.number} with Cursor` : undefined}
                    onClick={() => void launch(pr, request)}
                  >
                    {pending === launchTag(pr.key, request) ? 'Starting Cursor…' : 'Resolve with Cursor'}
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

function RunningNote({ session, prefix = null }: { session: CursorSession; prefix?: string | null }) {
  const links = cursorLinks(session.agentId)
  return (
    <p>
      {prefix ? `${prefix} · ` : ''}
      {cursorStatusLabel(session.status)}. {agentWork(session.kind)}{' '}
      <a className="external" href={links.webUrl} target="_blank" rel="noreferrer">
        Open session
      </a>
    </p>
  )
}

function Agents({ id, prs }: { id: string; prs: PullRequest[] }) {
  const sessions = prs
    .flatMap((pr) => (pr.cursorSessions ?? []).map((session) => ({ pr, session })))
    .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
  const { locked } = useStackLock()
  if (sessions.length === 0) {
    return (
      <td className="agents">
        <span className="sr">No Cursor agents</span>
      </td>
    )
  }
  const lead = leadingCursorStatus(sessions.map((item) => item.session.status)) ?? 'running'
  const active = sessions.filter((item) => cursorSessionActive(item.session.status)).length
  const only = sessions.length === 1 ? sessions[0]!.session : null
  const label = only ? cursorStatusLabel(only.status) : `${sessions.length} agents`
  const spoken = only
    ? `Cursor agent, ${agentKindLabel(only.kind)}, ${cursorStatusLabel(only.status)}`
    : `${sessions.length} Cursor agents, ${active} active`
  return (
    <td className="agents">
      <ClickCard
        id={id}
        disabled={locked}
        className={`cursor-chip ${lead}`}
        label={
          <>
            <span className="sr">{spoken}</span>
            <span aria-hidden="true">{label}</span>
          </>
        }
      >
        <AgentSessions sessions={sessions} showPr={prs.length > 1} />
      </ClickCard>
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

function AgentSessions({ sessions, showPr }: { sessions: { pr: PullRequest; session: CursorSession }[]; showPr: boolean }) {
  const single = sessions.length === 1
  return (
    <>
      {single ? null : <h3>Cursor agents</h3>}
      {sessions.map(({ pr, session }) => {
        const links = cursorLinks(session.agentId)
        return (
          <div key={session.agentId} className="cursor-session">
            <h3>
              {showPr ? `#${pr.number} · ` : ''}
              {agentKindLabel(session.kind)} · <span className={`agent-status ${session.status}`}>{cursorStatusLabel(session.status)}</span>
            </h3>
            {session.prompt ? <p className="agent-prompt">{session.prompt}</p> : null}
            <p>
              {cursorStatusDetail(session)}{' '}
              <span className="faint" title={formatExact(session.createdAt)}>
                Started {startedWhen(session.createdAt)}.
              </span>
            </p>
            {session.branch ? <p>Pushed to {session.branch}.</p> : null}
            {session.result ? (
              single ? (
                <Markdown className="cursor-result" text={session.result} />
              ) : (
                <details className="md-details">
                  <summary>Final reply</summary>
                  <div className="md-details-body">
                    <Markdown className="cursor-result" text={session.result} />
                  </div>
                </details>
              )
            ) : null}
            <div className="cursor-links">
              <a className="external" href={links.desktopUrl}>Open in Cursor</a>
              <a className="external" href={links.webUrl} target="_blank" rel="noreferrer">
                Open on the web
              </a>
            </div>
          </div>
        )
      })}
    </>
  )
}

function startedWhen(iso: string): string {
  const when = formatWhen(iso)
  return /^\d+[mhd]$/.test(when) ? `${when} ago` : when
}

function cursorStatusDetail(session: CursorSession): string {
  switch (session.status) {
    case 'creating':
      return 'Cursor is starting a cloud agent.'
    case 'running':
      return agentWork(session.kind)
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

type RowMenuProps = {
  id: string
  primaryKey: string
  /** Pull requests shown on this row. */
  prs: PullRequest[]
  stackKeys: string[]
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
  const promptTargets = props.prs.length ? props.prs : pr ? [pr] : []
  const failing = props.prs.filter((item) => failingChecks(item).length > 0)

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
      {promptTargets.length ? (
        <button type="button" className="menu-item" onClick={() => setView('prompt')}>
          Work on {promptTargets.length > 1 ? 'a pull request' : `#${promptTargets[0]!.number}`} with Cursor…
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
              ? 'Starting Cursor…'
              : running
                ? `Cursor is investigating CI on #${item.number}`
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
      <h3>Work on #{pr.number} with Cursor</h3>
      <p>Cursor gets this pull request’s link, branches, and linked issues, and pushes to its existing branch.</p>
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
        aria-label="Prompt for Cursor"
        placeholder="What should Cursor do?"
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
        {busy ? 'Starting Cursor…' : 'Start agent'}
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
  watch,
  progress = false,
  onMerge,
  onQueue,
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
  onQueue: (key: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onSetMergeWhenReady: (key: string, scope: MergeWatch['scope'], enabled: boolean) => Promise<void>
}) {
  if (mark) return <QueueStatus mark={mark} progress={progress} />
  if (watch) {
    return <MergeWhenReady pr={pr} scope={watch.scope} watch={watch} onChange={onSetMergeWhenReady} />
  }
  if (pr.isDraft) return <MarkReady pr={pr} onMarkReady={onMarkReady} />
  const count = canMergeSlice(ordered, pr.key)
  if (count != null) return <StackMergeButton count={count} pr={pr} onStackMerge={onStackMerge} />
  if (canSquashMerge(pr)) return <SplitMerge pr={pr} onMerge={onMerge} onQueue={onQueue} />
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
  const [action, setAction] = useState<'merge' | 'queue' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { locked } = useStackLock()
  const pending = action !== null
  const busy = pending || locked
  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])
  const label = action === 'queue' ? 'Queuing' : action === 'merge' ? 'Merging' : 'Merge'
  const described =
    action === 'queue' ? `Queuing #${pr.number}` : action === 'merge' ? `Merging #${pr.number}` : `Squash and merge #${pr.number}`
  return (
    <div className="merge-action">
      <div className="split-merge">
        <button
          type="button"
          className="primary merge"
          disabled={busy}
          aria-busy={busy}
          aria-label={described}
          onClick={() => {
            if (pendingRef.current || locked) return
            pendingRef.current = true
            setAction('merge')
            setError(null)
            void onMerge(pr.key).catch((caught: unknown) => {
              pendingRef.current = false
              setAction(null)
              setError(caught instanceof Error ? caught.message : 'Merge failed')
            })
          }}
        >
          {label}
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
            if (pendingRef.current || locked) return
            pendingRef.current = true
            setAction('queue')
            setOpen(false)
            setError(null)
            void onQueue(pr.key).catch((caught: unknown) => {
              pendingRef.current = false
              setAction(null)
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
  const panel = useRef<HTMLDivElement>(null)
  const rect = anchor.getBoundingClientRect()
  const menuHeight = 44
  const below = rect.bottom + 6
  const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 6) : below
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target
      // The menu is portaled onto document.body, so a press on Queue is outside the caret.
      // Closing on that press unmounts the item before its click can queue the pull request.
      if (target instanceof Node && (anchor.contains(target) || panel.current?.contains(target))) return
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
    <div ref={panel} className="popover merge-menu" style={{ top, left: Math.max(12, rect.right - 168) }} role="menu">
      <button type="button" className="menu-item" role="menuitem" onClick={onQueue}>
        Queue
      </button>
    </div>,
    document.body,
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
                  ? 'Starting Cursor…'
                  : `Investigate ${failing.length > 1 ? `#${pr.number} ` : ''}with Cursor`}
              </button>
            ))}
          </div>
          <p>Cursor reads the failing logs, pushes a fix if the cause is clear, and reports back if it is not.</p>
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
  return prs.some((pr) => approvedByLogin(pr, login))
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
        <p>
          Grey means no review is required. White is still waiting. Green outline is a human approval; a filled green circle means you approved.
          Red means changes are still requested. The check is any approval, the person is a human approval, and the arrow is GitHub’s merge
          requirement.
        </p>
      </div>
    </HoverCard>
  )
}
