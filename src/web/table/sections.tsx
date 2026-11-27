import type { ReactNode } from 'react'
import { rollup, segmentState } from '../../shared/segments.ts'
import type { LinearIssue } from '../../shared/types.ts'
import type { Bucket, ProjectGroup } from '../../shared/view.ts'
import { useViewer } from '../feedback.tsx'
import { isLinearIdentifier, IssueControls } from '../issue-controls.tsx'
import { COLUMNS, mergeLineOf, useTable } from './context.tsx'
import { BlockRows } from './rows.tsx'
import { Icon } from '../icons.tsx'

export function SectionBand({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const { collapsed, onToggleSection: onToggle } = useTable()
  const open = !collapsed.has(id)
  return (
    <>
      <tr className="band" data-flip={id}>
        <td colSpan={COLUMNS}>
          <SectionHead open={open} label={title} onToggle={() => onToggle(id)} action={action}>
            <SectionTitle open={open} onToggle={() => onToggle(id)}>
              {title}
            </SectionTitle>
          </SectionHead>
        </td>
      </tr>
      {open ? children : null}
    </>
  )
}

export function ProjectRows({ project }: { project: ProjectGroup }) {
  const shared = useTable()
  const count = project.issues.reduce((total, issue) => total + issue.count, 0)
  const open = !shared.collapsed.has(project.id)
  return (
    <>
      <tr className="project depth-1" data-flip={project.id}>
        <td colSpan={COLUMNS}>
          <SectionHead open={open} label={project.title} onToggle={() => shared.onToggleSection(project.id)} action={<GroupToggle id={project.id} />}>
            <SectionTitle open={open} onToggle={() => shared.onToggleSection(project.id)}>
              {project.title}
            </SectionTitle>
            <span className="section-meta">{count === 1 ? '1 pull request' : `${count} pull requests`}</span>
            <SectionRollup buckets={project.issues} />
          </SectionHead>
        </td>
      </tr>
      {open ? project.issues.map((bucket) => <BucketRows key={bucket.id} bucket={bucket} depth={2} />) : null}
    </>
  )
}

export function BucketRows({ bucket, depth, untitled = false }: { bucket: Bucket; depth: number; untitled?: boolean }) {
  const shared = useTable()
  const collapsible = Boolean(bucket.title) && !untitled
  const open = !collapsible || !shared.collapsed.has(bucket.id)
  return (
    <>
      {collapsible ? (
        <tr className={`section depth-${depth}`} data-flip={`${depth}:${bucket.id}`}>
          <td colSpan={COLUMNS}>
            <SectionHead open={open} label={bucket.title!} onToggle={() => shared.onToggleSection(bucket.id)}>
              {shared.linearConfigured ? <SectionIssue bucket={bucket} /> : null}
              {bucket.href ? (
                <a className="section-title" href={bucket.href} target="_blank" rel="noreferrer">
                  {bucket.title}
                </a>
              ) : (
                <SectionTitle open={open} onToggle={() => shared.onToggleSection(bucket.id)}>
                  {bucket.title}
                </SectionTitle>
              )}
              {bucket.meta ? <span className="section-meta">{bucket.meta}</span> : null}
              <SectionRollup buckets={[bucket]} />
            </SectionHead>
          </td>
        </tr>
      ) : null}
      {open ? (
        <>
          {bucket.stacks.map((block) => (
            <BlockRows key={block.id} bucket={bucket} block={block} tone={shared.tones.get(`${bucket.id}:${block.id}`) ?? 'a'} />
          ))}
          {bucket.singles.map((block) => (
            <BlockRows key={block.id} bucket={bucket} block={block} tone={null} />
          ))}
        </>
      ) : null}
    </>
  )
}

/** A section's name, which folds the section when pressed. */
function SectionTitle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className="section-title" aria-expanded={open} onClick={onToggle}>
      {children}
    </button>
  )
}

/** Whether a section lists its pull requests under a heading for each Linear issue. */
export function GroupToggle({ id }: { id: string }) {
  const { flat, onToggleFlat: onToggle } = useTable()
  return (
    <button
      type="button"
      className="section-group"
      aria-pressed={!flat.has(id)}
      title="Group this section's pull requests under each Linear issue"
      onClick={() => onToggle(id)}
    >
      <Icon name="tick" />
      Group by issue
    </button>
  )
}

function SectionHead({
  open,
  label,
  onToggle,
  action,
  children,
}: {
  open: boolean
  label: string
  onToggle: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="section-head">
      <div className="section-line">{children}</div>
      {action}
      <button type="button" className="section-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggle}>
        <Icon name="fold" />
      </button>
    </div>
  )
}

function SectionIssue({ bucket }: { bucket: Bucket }) {
  const { onUpdateIssue } = useTable()
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

/** Counts for a heading, so a collapsed section still says whether it needs you. Zero counts are left out. */
function SectionRollup({ buckets }: { buckets: Bucket[] }) {
  const { prByKey, mode } = useTable()
  const viewer = useViewer()
  const states = buckets.flatMap((bucket) =>
    [...bucket.stacks, ...bucket.singles].flatMap((block) =>
      block.rows.flatMap((row) => (row.type === 'pr' ? [segmentState(row.pr, mergeLineOf(block, row.pr.key, prByKey), mode, viewer)] : [])),
    ),
  )
  const counts = rollup(states)
  if (counts.ready + counts.you + counts.broken === 0) return null
  return (
    <span className="section-roll">
      {counts.broken > 0 ? <span className="broken">{counts.broken} broken</span> : null}
      {counts.you > 0 ? <span className="you">{counts.you === 1 ? '1 needs you' : `${counts.you} need you`}</span> : null}
      {counts.ready > 0 ? (
        <span className="ready">
          {counts.ready} {mode === 'review' ? 'approved by you' : 'ready'}
        </span>
      ) : null}
    </span>
  )
}
