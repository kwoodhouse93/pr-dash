import { type CSSProperties, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { stepLabel } from '../../shared/queue.ts'
import type { Rail } from '../../shared/rails.ts'
import { SEGMENT_LABEL, segmentState, type SegmentState } from '../../shared/segments.ts'
import { downstackKeys, type Parents } from '../../shared/stacks.ts'
import type { LinearIssue, PullRequest } from '../../shared/types.ts'
import { blockRails, type Bucket, type StackBlock } from '../../shared/view.ts'
import { Feedback, feedbackTarget, useViewer } from '../feedback.tsx'
import { isLinearIdentifier, IssueControls } from '../issue-controls.tsx'
import { usePrHref } from '../pr-links.tsx'
import { RepoIcon } from '../repo-mark.tsx'
import { Agents } from './agents-cell.tsx'
import { Conflict, lowestBehindKey, UpToDate } from './branch.tsx'
import { Age, Authors, CopyNumber, OpenLinks, Size, When } from './cells.tsx'
import { CiControl } from './ci.tsx'
import {
  COLUMNS,
  mergeLineOf,
  motionClass,
  MotionContext,
  pressedControl,
  shownLevel,
  type StackLock,
  StackLockContext,
  useHolds,
  useStackLock,
  useTable,
} from './context.tsx'
import { foremost, MergeControls, QueueStatus } from './merge.tsx'
import { ReviewControl } from './review.tsx'
import { RowMenu } from './row-menu.tsx'

type Spine = 'start' | 'mid' | 'end' | 'only'

function spineClass(spine: Spine | null, tone: 'a' | 'b' | null): string {
  if (!spine) return ''
  return ` spine-${spine}${tone ? ` tone-${tone}` : ''}`
}

function spineAt(index: number, total: number): Spine {
  if (total <= 1) return 'only'
  if (index === 0) return 'start'
  if (index === total - 1) return 'end'
  return 'mid'
}

export function BlockRows({ bucket, block, tone }: { bucket: Bucket; block: StackBlock; tone: 'a' | 'b' | null }) {
  const shared = useTable()
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
          <tr
            key={row.id}
            className={`ellipsis${rail ? ' forked' : ''}${spineClass(spine, stackTone)}${unfoldClass(unfoldAt(index))}`}
            style={unfoldStyle(unfoldAt(index))}
            data-flip={`${bucket.id}:${row.id}`}
          >
            <Grip spine={spine} rail={rail} hollow />
            <td />
            <td colSpan={COLUMNS - 2}>
              … {row.count} pull request{row.count === 1 ? '' : 's'} {row.place} · {row.reason}
            </td>
          </tr>
        ) : (
          <DataRow
            key={row.pr.id}
            pr={row.pr}
            flip={`${bucket.id}:${row.pr.key}`}
            unfold={unfoldAt(index)}
            block={block}
            child={block.collapsible}
            spine={spine}
            rail={rail}
            tone={stackTone}
            toggle={block.collapsible && row.pr.id === visible[0]?.id ? openId : null}
            hideIssue={bucket.issueId ?? undefined}
          />
        )
      })
    ) : (
      <SummaryRow
        key={block.id}
        block={block}
        visible={visible}
        flip={`${bucket.id}:${block.summary.topKey}`}
        openId={openId}
        spine="only"
        tone={stackTone}
        hideIssue={bucket.issueId ?? undefined}
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
  pr,
  flip,
  unfold,
  block,
  child,
  spine,
  rail,
  tone,
  toggle,
  hideIssue,
}: {
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
  /** The stack this row opens and shuts, when it is the first row of one. */
  toggle: string | null
  hideIssue?: string
}) {
  const { mode, prByKey, showRepo, queueByKey, onToggle } = useTable()
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
        onToggle(toggle)
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
        <Subline menuScope={pr.id} issues={hideIssue ? [] : pr.linearIssues} />
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
        <CiControl id={`ci:${pr.id}`} prs={[pr]} />
      </td>
      {pr.conflict ? (
        <Conflict id={`conflict:${pr.id}`} prs={[pr]} />
      ) : (
        <UpToDate id={`uptodate:${pr.id}`} targetKey={pr.behind ? pr.key : null} stackKeys={block.stackKeys} parents={block.parents} />
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
          <MergeControls pr={pr} ordered={mergeLineOf(block, pr.key, prByKey)} mark={mark} />
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
        queued={mark !== null}
      />
    </tr>
  )
}

function SummaryRow({
  block,
  visible,
  flip,
  openId,
  spine,
  tone,
  hideIssue,
}: {
  block: StackBlock
  visible: PullRequest[]
  flip: string
  openId: string
  spine: Spine
  tone: 'a' | 'b' | null
  hideIssue?: string
}) {
  const { mode, prByKey, showRepo, queueByKey, onToggle } = useTable()
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
      className={`stack ${ci === 'red' ? 'fail' : ''}${allDraft ? ' draft' : ''}${mark ? ' held' : ''}${locked ? ' pending' : ''}${spineClass(spine, tone)}${motionClass(
        visible.map((pr) => pr.key),
        motion,
      )}`}
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
            <SegmentRun nodes={forest} />
          </span>
          <a href={summaryHref} target="_blank" rel="noreferrer" title={summary.title}>
            {summary.title}
          </a>
          {branches > 1 ? <span className="pill">{branches} branches</span> : null}
          {summary.partial ? <span className="pill">partial</span> : null}
        </div>
        <Subline menuScope={block.id} issues={issues} />
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
        <CiControl id={`ci:${block.id}`} prs={visible} />
      </td>
      {summary.conflict ? (
        <Conflict id={`conflict:${block.id}`} prs={visible} />
      ) : (
        <UpToDate id={`uptodate:${block.id}`} targetKey={lowestBehindKey(block.stackKeys, visible)} stackKeys={block.stackKeys} parents={block.parents} />
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
          {top && !summary.partial ? <MergeControls pr={top} ordered={ordered} mark={mark} progress /> : mark ? <QueueStatus mark={mark} progress /> : null}
        </td>
      ) : null}
      <OpenLinks url={summary.url} repo={summary.repo} number={summary.number} />
      <RowMenu id={`menu:${block.id}`} primaryKey={summary.topKey} prs={visible} stackKeys={block.stackKeys} parents={block.parents} defaultWholeStack />
    </tr>
  )
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
function SegmentRun({ nodes }: { nodes: SegmentNode[] }) {
  const { mode, queueByKey: marks } = useTable()
  const { leaving } = useContext(MotionContext)
  if (nodes.length === 0) return null
  if (nodes.length > 1) {
    return (
      <span className="seg-fork">
        {nodes.map((node) => (
          <span key={node.pr.id} className="segments">
            <SegmentRun nodes={[node]} />
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
      <i
        className={`seg ${node.state}${queued}${leaving.has(node.pr.key) ? ' leaving' : ''}`}
        title={`#${node.pr.number} · ${step ? stepLabel(step) : SEGMENT_LABEL[mode][node.state]}`}
      />
      <SegmentRun nodes={node.above} />
    </>
  )
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

function Subline({ menuScope, issues }: { menuScope: string; issues: LinearIssue[] }) {
  const { linearConfigured, onUpdateIssue } = useTable()
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
