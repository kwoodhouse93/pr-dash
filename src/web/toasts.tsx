import { Toaster, toast } from 'sonner'
import type { PersonalBest } from '../shared/activity.ts'
import type { MergeEntry } from '../shared/queue.ts'
import { confetti, confettiShower } from './confetti.ts'
import { chime, type Chime } from './sounds.ts'

const BRIEF = 4000
const READABLE = 6000

let actionErrorId: string | number | null = null
/** Standing notices now up. One is redrawn as its detail changes, and only its arrival makes a sound. */
const standing = new Set<string | number>()

function arrive(id: string | number | undefined, kind: Chime) {
  if (id != null) {
    if (standing.has(id)) return
    standing.add(id)
  }
  chime(kind)
}

function leave(id: string | number) {
  standing.delete(id)
  toast.dismiss(id)
}

/** `scheme` is whether the theme in use is dark or light. The colours come from the theme either way. */
export function Toasts({ scheme }: { scheme: 'dark' | 'light' }) {
  return (
    <Toaster
      theme={scheme}
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

type NoticeAction = { label: string; onClick: () => void; primary?: boolean /** Leave the notice up after the click. */; keep?: boolean }

/** How many detail lines a notice lists before counting the rest. */
const LINES_SHOWN = 3

/** The shape every longer notice shares: a short heading, the detail in clamped lines, then what you can do about it. */
function notice(
  tone: 'info' | 'warning' | 'error',
  heading: string,
  options: { id?: string | number; lines?: string[]; actions?: NoticeAction[]; duration: number },
): string | number {
  const lines = (options.lines ?? []).map((line) => line.trim()).filter((line) => line && line !== heading)
  const actions = options.actions ?? []
  const show = tone === 'error' ? toast.error : tone === 'warning' ? toast.warning : toast.info
  if (tone !== 'info') arrive(options.id, tone)
  const id: string | number = show(heading, {
    id: options.id,
    duration: options.duration,
    description:
      lines.length === 0 && actions.length === 0 ? undefined : (
        <div className="notice-toast">
          {lines.slice(0, LINES_SHOWN).map((line, index) => (
            <p key={index} className="notice-line" title={line}>
              {line}
            </p>
          ))}
          {lines.length > LINES_SHOWN ? <p className="notice-more">and {lines.length - LINES_SHOWN} more</p> : null}
          {actions.length > 0 ? (
            <div className="notice-actions">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={action.primary ? 'primary' : 'ghost'}
                  onClick={() => {
                    if (!action.keep) toast.dismiss(id)
                    action.onClick()
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ),
  })
  return id
}

const PAUSED = /^GitHub GraphQL refreshes are paused until /

/**
 * `heading` names what failed and `message` is the detail under it; with no heading the message is the whole notice.
 * A refresh paused for GitHub's budget is not a failure, so it says when it resumes instead.
 */
export function toastError(message: string, options: { heading?: string; onRetry?: () => void; retryLabel?: string } = {}) {
  clearActionError()
  if (PAUSED.test(message)) {
    actionErrorId = notice('info', 'Refreshes paused', { lines: [message.replace(PAUSED, 'Resumes ')], duration: READABLE })
    return
  }
  actionErrorId = notice('error', options.heading ?? message, {
    lines: options.heading ? [message] : [],
    actions: options.onRetry ? [{ label: options.retryLabel ?? 'Retry', onClick: options.onRetry, primary: true }] : [],
    duration: options.onRetry ? READABLE * 2 : READABLE,
  })
}

/** Problems a refresh finished with, one per line. It stays until a refresh comes back clean. */
export function toastSyncWarning(warning: string | null, actions: { onRetry: () => void; onSettings: () => void }) {
  if (!warning) {
    leave('snapshot-warning')
    return
  }
  notice('warning', 'Refresh finished with problems', {
    id: 'snapshot-warning',
    lines: warning.split(/;\s+|\n/),
    actions: [
      { label: 'Retry', onClick: actions.onRetry, primary: true },
      { label: 'Settings', onClick: actions.onSettings },
    ],
    duration: Infinity,
  })
}

export function toastRerun(result: { reran: number; errors: string[] }, onRetryFailed: () => void) {
  const count = `Reran ${result.reran} workflow${result.reran === 1 ? '' : 's'}`
  if (result.errors.length === 0) {
    toastSuccess(`${count}.`)
    return
  }
  notice('warning', `${count}, ${result.errors.length} could not be rerun`, {
    lines: result.errors,
    actions: [{ label: 'Retry failed', onClick: onRetryFailed, primary: true }],
    duration: READABLE * 2,
  })
}

/** Shown while pull requests carry Linear links but no key is set. `onHide` is the user asking not to see it again. */
export function toastLinearHint(show: boolean, onHide: () => void) {
  if (!show) {
    toast.dismiss('linear-setup')
    return
  }
  notice('info', 'Linear key not set', {
    id: 'linear-setup',
    lines: ['Status, assignee and project need LINEAR_API_KEY. Issue titles still come from GitHub.'],
    actions: [{ label: 'Don’t show again', onClick: onHide }],
    duration: Infinity,
  })
}

export function toastSuccess(message: string) {
  chime('success')
  toast.success(message, { duration: BRIEF })
}

/** Merges that just landed: the pull request, or how many, then the day's count so far. */
export function toastLanded(landed: { number: number; title: string }[], today: number) {
  if (landed.length === 0) return
  const only = landed.length === 1 ? landed[0]! : null
  chime('landed')
  confetti()
  toast.success(only ? `Landed #${only.number}` : `Landed ${landed.length} pull requests`, {
    duration: READABLE,
    icon: (
      <span className="landed-pile" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    ),
    description: (
      <div className="notice-toast">
        <p className="notice-line">{only ? only.title : landed.map((pr) => `#${pr.number}`).join(', ')}</p>
        <p className="notice-more">{today === 1 ? 'First merge today' : `${today} merged today`}</p>
      </div>
    ),
  })
}

/** A day or a week that has passed your best on record: what it stands at, and what it beat. */
export function toastBest(bests: PersonalBest[]) {
  if (bests.length === 0) return
  chime('landed')
  confettiShower()
  toast.success('Personal best', {
    duration: READABLE * 2,
    icon: (
      <span className="best-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    ),
    description: (
      <div className="notice-toast">
        {bests.map((best) => (
          <p key={`${best.kind}-${best.span}`} className="notice-line">
            {best.count} {best.kind} {best.span === 'day' ? 'today' : 'this week'}, past your best {best.span} of {best.was}
          </p>
        ))}
      </div>
    ),
  })
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
    leave(HELD_ID)
    return
  }
  const only = entries.length === 1 ? entries[0]! : null
  const failedAt = only?.steps.findIndex((step) => step.status === 'failed') ?? -1
  const step = only && failedAt >= 0 ? only.steps[failedAt]! : null
  const why = only ? (only.error ?? step?.detail ?? null) : null
  arrive(HELD_ID, 'warning')
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
        <div className="notice-actions">
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
