import { useState, type ReactNode } from 'react'
import { stepLabel, type MergeEntry, type MergeLog, type MergeStep, type MergeWatch, type QueueSnapshot } from '../shared/queue.ts'
import { formatClock, formatDuration, formatExact, formatWhen } from './format.ts'
import { prHref, usePrLinkHost } from './pr-links.tsx'

export type QueuePull = { number: number; title: string; url: string }

type CancelFn = (id: string) => Promise<void>
type RetryFn = (id: string) => Promise<void>
type MoveFn = (id: string, direction: 'up' | 'down') => Promise<void>

export function MergeQueuePage({
  queue,
  pulls,
  onCancel,
  onRetry,
  onMove,
}: {
  queue: QueueSnapshot | null
  /** Open pull requests by key, used to name the ones set to merge when ready. */
  pulls?: Map<string, QueuePull>
  onCancel: CancelFn
  onRetry: RetryFn
  onMove: MoveFn
}) {
  if (!queue) {
    return (
      <div className="queue-page">
        <div className="empty">
          <h2>Loading the queue</h2>
        </div>
      </div>
    )
  }
  const held = queue.entries.filter((entry) => entry.status === 'failed')
  const active = queue.entries.filter((entry) => entry.status === 'active')
  const next = queue.entries.filter((entry) => entry.status !== 'failed' && entry.status !== 'active')
  const idle = queue.entries.length === 0 && queue.watches.length === 0
  return (
    <div className="queue-page">
      {idle ? (
        <div className="empty">
          <h2>Nothing queued</h2>
          <p>Queue a pull request, or merge a stack, and it will show up here.</p>
        </div>
      ) : null}
      {held.length > 0 ? (
        <section>
          <h2 className="queue-label held">
            Held <span>{held.length}</span>
          </h2>
          {held.map((entry) => (
            <NowCard key={entry.id} entry={entry} onCancel={onCancel} onRetry={onRetry} />
          ))}
        </section>
      ) : null}
      {active.length > 0 ? (
        <section>
          <h2 className="queue-label">Merging now</h2>
          {active.map((entry) => (
            <NowCard key={entry.id} entry={entry} onCancel={onCancel} />
          ))}
        </section>
      ) : null}
      {next.length > 0 || queue.watches.length > 0 ? (
        <section>
          <h2 className="queue-label">
            Up next {next.length > 0 ? <span>{next.length}</span> : null}
          </h2>
          <ol className="queue-rows">
            {next.map((entry, index) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                lead={<span className="queue-pos">{index + 1}</span>}
                trail={
                  <>
                    <span className="queue-repo">{entry.repo}</span>
                    <IconButton label="Move up" icon="up" disabled={index === 0} onClick={() => void onMove(entry.id, 'up')} />
                    <IconButton label="Move down" icon="down" disabled={index === next.length - 1} onClick={() => void onMove(entry.id, 'down')} />
                    <IconButton label="Remove from the queue" icon="x" onClick={() => void onCancel(entry.id)} />
                  </>
                }
              />
            ))}
            {queue.watches.map((watch) => (
              <WatchRow key={watch.key} watch={watch} pull={pulls?.get(watch.key)} />
            ))}
          </ol>
        </section>
      ) : null}
      {queue.history.length > 0 ? (
        <section>
          <h2 className="queue-label">Earlier</h2>
          <ol className="queue-rows">
            {queue.history.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                lead={<span className={`queue-dot ${entry.error ? 'failed' : entry.status}`} role="img" aria-label={outcome(entry)} title={outcome(entry)} />}
                trail={
                  <>
                    {entry.startedAt && entry.finishedAt ? (
                      <span className="queue-took">took {formatDuration(Date.parse(entry.finishedAt) - Date.parse(entry.startedAt))}</span>
                    ) : null}
                    <span className="queue-when" title={formatExact(entry.finishedAt ?? entry.updatedAt)}>
                      {ago(entry.finishedAt ?? entry.updatedAt)}
                    </span>
                  </>
                }
              />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function NowCard({ entry, onCancel, onRetry }: { entry: MergeEntry; onCancel: CancelFn; onRetry?: RetryFn }) {
  const failed = entry.status === 'failed'
  const [retrying, setRetrying] = useState(false)
  const merged = entry.steps.filter((step) => step.status === 'merged').length
  const shape = entry.kind === 'stack' ? `stack of ${entry.steps.length} into ${entry.trunk}` : `pull request into ${entry.trunk}`
  return (
    <article className={`queue-now ${entry.status}`}>
      <header>
        <div className="queue-now-title">
          <h3>{entry.title}</h3>
          <p>
            {entry.repo} · {shape}
            {merged > 0 ? ` · ${merged} merged` : ''}
          </p>
        </div>
        {!failed && entry.startedAt ? (
          <span className="queue-clock" title={`Started ${formatExact(entry.startedAt)}`}>
            {formatClock(Date.now() - Date.parse(entry.startedAt))}
          </span>
        ) : null}
        {failed && onRetry ? (
          <button
            type="button"
            className="primary"
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => {
              setRetrying(true)
              void onRetry(entry.id).finally(() => setRetrying(false))
            }}
          >
            {retrying ? 'Retrying' : 'Retry'}
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={() => void onCancel(entry.id)}>
          {failed ? 'Remove' : 'Cancel'}
        </button>
      </header>
      {entry.error ? <p className="queue-error">{entry.error}</p> : null}
      <StepRail steps={entry.steps} error={entry.error} />
      {entry.logs.length > 0 ? <QueueLogs logs={entry.logs} latest /> : null}
    </article>
  )
}

function EntryRow({ entry, lead, trail }: { entry: MergeEntry; lead: ReactNode; trail: ReactNode }) {
  const [open, setOpen] = useState(false)
  const only = entry.kind === 'pr' ? entry.steps[0] : undefined
  return (
    <li>
      <div className="queue-row">
        {lead}
        <button type="button" className="queue-row-main" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="queue-row-title">{entry.title}</span>
          {only ? <span className="queue-num">#{only.number}</span> : <Segments steps={entry.steps} />}
        </button>
        {trail}
      </div>
      {open ? (
        <div className="queue-row-detail">
          {entry.error ? <p className="queue-error">{entry.error}</p> : null}
          <StepRail steps={entry.steps} error={entry.error} />
          {entry.logs.length > 0 ? <QueueLogs logs={entry.logs} /> : null}
        </div>
      ) : null}
    </li>
  )
}

function WatchRow({ watch, pull }: { watch: MergeWatch; pull: QueuePull | undefined }) {
  const host = usePrLinkHost()
  const reason = watch.detail ?? 'Joins the queue when ready'
  return (
    <li>
      <div className="queue-row watch">
        <span className="queue-pos" />
        <span className="queue-row-main">
          {pull ? (
            <a className="queue-row-title" href={prHref(pull.url, host)} target="_blank" rel="noreferrer">
              {pull.title}
            </a>
          ) : (
            <span className="queue-row-title">{watch.key}</span>
          )}
          {watch.keys.length > 1 ? (
            <span className="queue-num">{watch.keys.length} PRs</span>
          ) : pull ? (
            <span className="queue-num">#{pull.number}</span>
          ) : null}
        </span>
        <span className="queue-why" title={reason}>
          {reason}
        </span>
      </div>
    </li>
  )
}

/** `error` is the entry's own message, shown above the rail, so a step that only repeats it stays quiet. */
function StepRail({ steps, error }: { steps: MergeStep[]; error: string | null }) {
  const host = usePrLinkHost()
  return (
    <ol className="queue-rail">
      {steps.map((step) => {
        const tone = stepTone(step)
        const note = tone === 'live' ? (step.detail ?? stepLabel(step.status)) : tone === 'failed' && step.detail !== error ? step.detail : null
        return (
          <li key={step.id} className={tone}>
            <span className={`queue-dot ${tone}`} role="img" aria-label={stepLabel(step.status)} title={stepLabel(step.status)} />
            <a href={prHref(step.url, host)} target="_blank" rel="noreferrer">
              <span className="queue-num">#{step.number}</span> {step.title}
            </a>
            {note ? <span className="queue-note">{note}</span> : null}
            {step.role === 'restack' ? <span className="queue-tag">rebase only</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Segments({ steps }: { steps: MergeStep[] }) {
  const done = steps.filter((step) => stepTone(step) === 'done').length
  return (
    <span className="queue-segs" role="img" aria-label={`${done} of ${steps.length} done`}>
      {steps.map((step) => (
        <i key={step.id} className={stepTone(step)} />
      ))}
    </span>
  )
}

function QueueLogs({ logs, latest = false }: { logs: MergeLog[]; latest?: boolean }) {
  const [open, setOpen] = useState(false)
  const count = logs.length === 1 ? '1 line' : `${logs.length} lines`
  const last = logs[logs.length - 1]
  return (
    <div className={`queue-logs${latest ? ' latest' : ''}`}>
      <div className="queue-log-foot">
        {latest && !open && last ? <span className="queue-log-last">{logLine(last)}</span> : null}
        <button
          type="button"
          className="queue-log-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Logs
          <span className="count">{count}</span>
        </button>
      </div>
      {open ? <pre className="queue-log">{logs.map(logLine).join('\n')}</pre> : null}
    </div>
  )
}

const ICONS = {
  up: 'M8 12.5v-9M4 7l4-4 4 4',
  down: 'M8 3.5v9M4 9l4 4 4-4',
  x: 'M4 4l8 8M12 4l-8 8',
}

function IconButton({ label, icon, disabled, onClick }: { label: string; icon: keyof typeof ICONS; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="queue-ic" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function stepTone(step: MergeStep): 'done' | 'live' | 'failed' | 'cancelled' | 'queued' {
  switch (step.status) {
    case 'merged':
    case 'restacked':
      return 'done'
    case 'waiting':
    case 'rebasing':
    case 'merging':
      return 'live'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'queued':
      return 'queued'
  }
}

function outcome(entry: MergeEntry): string {
  if (entry.error) return 'Failed'
  return entry.status === 'done' ? 'Merged' : 'Cancelled'
}

function ago(iso: string): string {
  const when = formatWhen(iso)
  return /^\d+[mhd]$/.test(when) ? `${when} ago` : when
}

function logLine(line: MergeLog): string {
  return `${line.at.slice(11, 19)}  ${line.message}`
}
