import { Toaster, toast } from 'sonner'
import type { MergeEntry } from '../shared/queue.ts'

const BRIEF = 4000
const READABLE = 6000

let actionErrorId: string | number | null = null

export function Toasts() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      closeButton
      richColors
      expand
      visibleToasts={5}
      duration={BRIEF}
      gap={10}
      offset={16}
      style={{ fontFamily: '"Source Sans 3", sans-serif', ['--width' as string]: '380px' }}
    />
  )
}

export function clearActionError() {
  if (actionErrorId == null) return
  toast.dismiss(actionErrorId)
  actionErrorId = null
}

export function toastError(message: string) {
  clearActionError()
  actionErrorId = toast.error(message, { duration: READABLE })
}

export function toastSuccess(message: string) {
  toast.success(message, { duration: BRIEF })
}

export function toastWarning(message: string, id?: string) {
  toast.warning(message, { id, duration: READABLE })
}

export function toastSticky(message: string, id: string, tone: 'info' | 'warning' | 'error' = 'info') {
  const show = tone === 'error' ? toast.error : tone === 'warning' ? toast.warning : toast.info
  show(message, { id, duration: Infinity })
}

export function dismissToast(id: string) {
  toast.dismiss(id)
}

const HELD_ID = 'queue-held'
/** More held merges than this are counted, not listed. */
const HELD_LISTED = 3

/**
 * One notice for the merges the queue has set aside. A single one names where it stopped and can be retried from here;
 * several are listed by title and sent to the queue page. It stays until none are held.
 */
export function toastHeld(entries: MergeEntry[], actions: { onRetry: (entryId: string) => void; onView: () => void }) {
  if (entries.length === 0) {
    toast.dismiss(HELD_ID)
    return
  }
  const only = entries.length === 1 ? entries[0]! : null
  const failedAt = only?.steps.findIndex((step) => step.status === 'failed') ?? -1
  const step = only && failedAt >= 0 ? only.steps[failedAt]! : null
  const why = only ? (only.error ?? step?.detail ?? null) : null
  const view = () => {
    toast.dismiss(HELD_ID)
    actions.onView()
  }
  toast.warning(only ? 'Merge held' : `${entries.length} merges held`, {
    id: HELD_ID,
    duration: Infinity,
    description: (
      <div className="held-toast">
        {only ? (
          <>
            <p className="held-title" title={only.title}>
              {only.title}
            </p>
            {step ? (
              <p className="held-where">
                Stopped at #{step.number}
                {only.steps.length > 1 ? ` · ${failedAt + 1} of ${only.steps.length}` : ''}
              </p>
            ) : null}
            {why ? (
              <p className="held-why" title={why}>
                {why}
              </p>
            ) : null}
          </>
        ) : (
          <ul>
            {entries.slice(0, HELD_LISTED).map((entry) => (
              <li key={entry.id} className="held-title" title={entry.title}>
                {entry.title}
              </li>
            ))}
            {entries.length > HELD_LISTED ? <li className="held-where">and {entries.length - HELD_LISTED} more</li> : null}
          </ul>
        )}
        <div className="held-actions">
          {only ? (
            <button type="button" className="primary" onClick={() => actions.onRetry(only.id)}>
              Retry
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={view}>
            {only ? 'View' : 'View queue'}
          </button>
        </div>
      </div>
    ),
  })
}
