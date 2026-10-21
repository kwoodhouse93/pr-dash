import { useRef, useState } from 'react'
import { checkPhase, ciDetail, ciLabel, worstCi } from '../shared/ci.ts'
import { canSquashMerge } from '../shared/merge.ts'
import type { StackSummary } from '../shared/stacks.ts'
import type { Check, Initiative, LinearIssue, MergeMark, PullRequest, Sort, SortKey } from '../shared/types.ts'
import type { Bucket, Outline, StackBlock } from '../shared/view.ts'
import { TagEditor } from './editors.tsx'
import { formatCount, formatExact, formatWhen } from './format.ts'
import { isLinearIdentifier, IssueControls } from './issue-controls.tsx'
import { ClickCard, HoverCard } from './menus.tsx'

const COLUMNS = 13

export function PrTable({
  outline,
  sort,
  initiatives,
  prByKey,
  repoColor,
  expanded,
  onSort,
  onToggle,
  onAssign,
  onCreateAssigned,
  onMerge,
  onRerun,
  linearConfigured,
  onUpdateIssue,
}: {
  outline: Outline
  sort: Sort
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  repoColor: Map<string, string>
  expanded: Set<string>
  onSort: (key: SortKey) => void
  onToggle: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  linearConfigured: boolean
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const tones = stackTones(outline)
  const shared = {
    namesList: initiatives,
    prByKey,
    repoColor,
    tones,
    expanded,
    onToggle,
    onAssign,
    onCreateAssigned,
    onMerge,
    onRerun,
    linearConfigured,
    onUpdateIssue,
  }
  return (
    <table className="prs">
      <thead>
        <tr>
          <th className="grip" aria-label="Stack" />
          <th className="num">#</th>
          <SortHeader label="Title" sortKey="title" sort={sort} onSort={onSort} />
          <SortHeader label="Repo" sortKey="repo" sort={sort} onSort={onSort} />
          <SortHeader label="Size" sortKey="size" sort={sort} onSort={onSort} />
          <SortHeader label="Created" sortKey="created" sort={sort} onSort={onSort} />
          <SortHeader label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
          <SortHeader label="CI" sortKey="ci" sort={sort} onSort={onSort} />
          <th className="conflict">Conflict</th>
          <th>Review</th>
          <th>Feedback</th>
          <th className="merge">Merge</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {outline.projects.length ? <Band title="Linear projects" /> : null}
        {outline.projects.map((project) => (
          <ProjectRows key={project.id} title={project.title} issues={project.issues} {...shared} />
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
  namesList: Initiative[]
  prByKey: Map<string, PullRequest>
  repoColor: Map<string, string>
  tones: Map<string, 'a' | 'b'>
  expanded: Set<string>
  onToggle: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
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

function ProjectRows({ title, issues, ...shared }: { title: string; issues: Bucket[] } & RowShared) {
  const count = issues.reduce((total, issue) => total + issue.count, 0)
  return (
    <>
      <tr className="project depth-1">
        <td colSpan={COLUMNS}>
          <span className="section-title">{title}</span>
          <span className="section-meta">{count === 1 ? '1 pull request' : `${count} pull requests`}</span>
        </td>
      </tr>
      {issues.map((bucket) => (
        <BucketRows key={bucket.id} bucket={bucket} depth={2} {...shared} />
      ))}
    </>
  )
}

function BucketRows({ bucket, depth, untitled = false, ...shared }: { bucket: Bucket; depth: number; untitled?: boolean } & RowShared) {
  return (
    <>
      {bucket.title && !untitled ? (
        <tr className={`section depth-${depth}`}>
          <td colSpan={COLUMNS}>
            <span className="section-line">
              {shared.linearConfigured ? (
                <SectionIssue bucket={bucket} onUpdateIssue={shared.onUpdateIssue} />
              ) : null}
              {bucket.href ? (
                <a className="section-title" href={bucket.href} target="_blank" rel="noreferrer">
                  {bucket.title}
                </a>
              ) : (
                <span className="section-title">{bucket.title}</span>
              )}
              {bucket.meta ? <span className="section-meta">{bucket.meta}</span> : null}
            </span>
          </td>
        </tr>
      ) : null}
      {bucket.stacks.map((block) => (
        <BlockRows key={block.id} bucket={bucket} block={block} tone={shared.tones.get(`${bucket.id}:${block.id}`) ?? 'a'} {...shared} />
      ))}
      {bucket.singles.map((block) => (
        <BlockRows key={block.id} bucket={bucket} block={block} tone={null} {...shared} />
      ))}
    </>
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
  const visible = block.rows.flatMap((row) => (row.type === 'pr' ? [row.pr] : []))
  const stackTone = block.collapsible ? tone : null
  if (!block.collapsible || open) {
    return block.rows.map((row, index) => {
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
          onRerun={shared.onRerun}
          onUpdateIssue={shared.onUpdateIssue}
        />
      )
    })
  }
  return (
    <SummaryRow
      key={block.id}
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
      onUpdateIssue={shared.onUpdateIssue}
    />
  )
}

function DataRow({
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
  onRerun,
  onUpdateIssue,
}: {
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
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  return (
    <tr
      className={`${child ? 'child' : ''} ${pr.ci === 'red' ? 'fail' : ''} ${toggle ? 'stack' : ''}${spineClass(spine, tone)}`}
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
          {pr.behind ? <span className="pill">Behind</span> : null}
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
      <Conflict conflict={pr.conflict} />
      <td>
        <ReviewControl id={`review:${pr.id}`} prs={[pr]} />
      </td>
      <td>
        <Feedback
          threads={pr.threadCount}
          unresolved={pr.unresolvedCount}
          awaiting={pr.awaitingYouCount}
          truncated={pr.threadsTruncated}
        />
      </td>
      <td className="merge">
        <MergeButton pr={pr} onMerge={onMerge} />
      </td>
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
  onUpdateIssue,
}: {
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
  onUpdateIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const summary = block.summary
  const issues = sharedIssues(visible, hideIssue)
  return (
    <tr
      className={`stack ${summary.ci === 'red' ? 'fail' : ''}${spineClass(spine, tone)}`}
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
          {summary.behind ? <span className="pill">Behind</span> : null}
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
      <Conflict conflict={summary.conflict} />
      <td>
        <ReviewControl id={`review:${block.id}`} prs={visible} summary={summary} />
      </td>
      <td>
        <Feedback threads={summary.threadCount} unresolved={summary.unresolvedCount} awaiting={summary.awaitingYouCount} truncated={false} />
      </td>
      <td className="merge" />
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
  if (issues.length === 0) return null
  return (
    <div className="subline">
      {issues.map((issue) => (
        <span key={issue.identifier} className="issue-ref">
          {linearConfigured && isLinearIdentifier(issue.identifier) ? (
            <IssueControls menuKey={`${menuScope}:${issue.identifier}`} issue={issue} onUpdate={onUpdateIssue} />
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

function Conflict({ conflict }: { conflict: boolean }) {
  return (
    <td className="conflict">
      {conflict ? (
        <span className="conflict-x" title="Merge conflict">
          <span className="sr">Merge conflict</span>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
      ) : (
        <span className="sr">No conflict</span>
      )}
    </td>
  )
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
  return (
    <td className="row-actions">
      <ClickCard
        id={props.id}
        className="row-menu"
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

function MergeButton({ pr, onMerge }: { pr: PullRequest; onMerge: (key: string) => Promise<void> }) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!canSquashMerge(pr)) return null
  return (
    <div className="merge-action">
      <button
        type="button"
        className="primary merge"
        disabled={pending}
        aria-busy={pending}
        aria-label={pending ? `Merging #${pr.number}` : `Squash and merge #${pr.number}`}
        onClick={() => {
          if (pendingRef.current) return
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
      {error ? <p className="merge-error">{error}</p> : null}
    </div>
  )
}

function Feedback({
  threads,
  unresolved,
  awaiting,
  truncated,
}: {
  threads: number
  unresolved: number
  awaiting: number
  truncated: boolean
}) {
  if (threads === 0) return <span className="feedback">0 threads</span>
  return (
    <span className="feedback" title="Awaiting you means an unresolved thread whose latest human comment is not yours.">
      {awaiting > 0 ? <em className="await">{awaiting} awaiting</em> : null}
      {awaiting > 0 && unresolved > 0 ? <span className="dot">·</span> : null}
      {unresolved > 0 ? (
        <span>
          {unresolved} unresolved
        </span>
      ) : null}
      {awaiting > 0 || unresolved > 0 ? <span className="dot">·</span> : null}
      <span>
        {threads}
        {truncated ? '+' : ''} thread{threads === 1 ? '' : 's'}
      </span>
    </span>
  )
}

function CiControl({ id, prs, onRerun }: { id: string; prs: PullRequest[]; onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string> }) {
  const level = worstCi(prs.map((pr) => pr.ci))
  return (
    <HoverCard id={id} className={`ci ${level}`} label={ciLabel(level)}>
      <CiPanel prs={prs} onRerun={onRerun} />
    </HoverCard>
  )
}

function CiPanel({ prs, onRerun }: { prs: PullRequest[]; onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string> }) {
  const checks = prs.flatMap((pr) => pr.checks.map((check) => ({ pr, check })))
  const grouped = new Map<string, { pr: PullRequest; check: Check }[]>()
  for (const item of checks) {
    const name = item.check.workflowName ?? 'Other'
    const list = grouped.get(name) ?? []
    list.push(item)
    grouped.set(name, list)
  }
  return (
    <div>
      <h3>{prs.length === 1 ? ciDetail(prs[0]!.ci) : 'Checks across this stack'}</h3>
      {[...grouped.entries()].map(([workflow, items]) => (
        <div key={workflow} className="check-group">
          <h4>{workflow}</h4>
          {items.map(({ pr, check }) => {
            const phase = checkPhase(check)
            return (
              <div key={`${pr.id}:${check.name}`} className="check">
                <i className={phase === 'fail' ? 'fail' : phase === 'pending' ? 'pending' : 'success'} />
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
                <span className="req">{check.required ? 'Required' : 'Optional'}</span>
              </div>
            )
          })}
        </div>
      ))}
      {checks.length === 0 ? <p>No checks on the latest commit.</p> : null}
      <RerunActions keys={prs.map((pr) => pr.key)} onRerun={onRerun} />
    </div>
  )
}

function RerunActions({ keys, onRerun }: { keys: string[]; onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string> }) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(mode: 'failed' | 'all') {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await onRerun(keys, mode))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Rerun failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="popover-actions">
        <button type="button" disabled={busy} onClick={() => void run('failed')}>
          Rerun failed
        </button>
        <button type="button" disabled={busy} onClick={() => void run('all')}>
          Rerun all
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
  return (
    <HoverCard
      id={id}
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
