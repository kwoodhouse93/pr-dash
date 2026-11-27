import { useId, useRef, useState } from 'react'
import { canMergeSlice, canSquashMerge } from '../../shared/merge.ts'
import { type RowMark, stepLabel, type StepStatus } from '../../shared/queue.ts'
import type { PullRequest } from '../../shared/types.ts'
import { HoverCard, PopBody, PopHead, useMenuClose } from '../menus.tsx'
import { useStackLock, useTable } from './context.tsx'

const MARK_RANK: StepStatus[] = ['failed', 'merging', 'rebasing', 'waiting', 'queued', 'restacked', 'merged', 'cancelled']

export function foremost(keys: string[], marks: Map<string, RowMark>): RowMark | null {
  const found = keys.map((key) => marks.get(key)).filter((mark): mark is RowMark => mark != null)
  found.sort((a, b) => MARK_RANK.indexOf(a.status) - MARK_RANK.indexOf(b.status))
  return found[0] ?? null
}

export function MergeControls({
  pr,
  ordered,
  mark,
  progress = false,
}: {
  pr: PullRequest
  ordered: PullRequest[]
  mark: RowMark | null
  progress?: boolean
}) {
  if (mark) return <QueueStatus mark={mark} progress={progress} />
  if (pr.isDraft) return <MarkReady pr={pr} />
  const count = canMergeSlice(ordered, pr.key)
  if (count != null) return <StackMergeButton count={count} pr={pr} />
  if (canSquashMerge(pr)) return <MergeButton pr={pr} />
  return null
}

function MarkReady({ pr }: { pr: PullRequest }) {
  const { onMarkReady } = useTable()
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

export function QueueStatus({ mark, progress }: { mark: RowMark; progress: boolean }) {
  const { onRetry } = useTable()
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
            <PopHead title="Why it stopped" />
            <PopBody>
              <p className="merge-why">{why}</p>
            </PopBody>
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

function StackMergeButton({ count, pr }: { count: number; pr: PullRequest }) {
  const { onStackMerge } = useTable()
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
function MergeButton({ pr }: { pr: PullRequest }) {
  const { onMerge } = useTable()
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
