import { useState } from 'react'
import { stepLabel, type MergeEntry, type MergeLog, type QueueSnapshot } from '../shared/queue.ts'
import { formatExact } from './format.ts'
import { prHref, usePrLinkHost } from './pr-links.tsx'

export function MergeQueuePage({
  queue,
  onCancel,
  onMove,
}: {
  queue: QueueSnapshot | null
  onCancel: (id: string) => Promise<void>
  onMove: (id: string, direction: 'up' | 'down') => Promise<void>
}) {
  if (!queue) {
    return (
      <div className="empty">
        <h2>Loading the queue</h2>
      </div>
    )
  }
  return (
    <div className="queue-page">
      {queue.entries.length === 0 ? (
        <div className="empty">
          <h2>Nothing queued</h2>
          <p>Queue a pull request, or merge a stack, and it will show up here.</p>
        </div>
      ) : (
        <ol className="queue-list">
          {queue.entries.map((entry, index) => (
            <QueueCard
              key={entry.id}
              entry={entry}
              interactive
              canUp={entry.status === 'queued' && queue.entries.slice(0, index).some((item) => item.status === 'queued')}
              canDown={entry.status === 'queued' && queue.entries.slice(index + 1).some((item) => item.status === 'queued')}
              onCancel={onCancel}
              onMove={onMove}
            />
          ))}
        </ol>
      )}
      {queue.history.length > 0 ? (
        <section className="queue-history">
          <h2>History</h2>
          {queue.history.map((entry) => (
            <QueueCard key={entry.id} entry={entry} interactive={false} canUp={false} canDown={false} onCancel={onCancel} onMove={onMove} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function QueueCard({
  entry,
  interactive,
  canUp,
  canDown,
  onCancel,
  onMove,
}: {
  entry: MergeEntry
  interactive: boolean
  canUp: boolean
  canDown: boolean
  onCancel: (id: string) => Promise<void>
  onMove: (id: string, direction: 'up' | 'down') => Promise<void>
}) {
  const open = interactive && (entry.status === 'queued' || entry.status === 'active' || entry.status === 'failed')
  const host = usePrLinkHost()
  return (
    <article className={`queue-card ${entry.status}`}>
      <header>
        <div>
          <h3>
            <span className={`pill queue ${entry.status}`}>{entry.status === 'active' ? 'Merging' : titleCase(entry.status)}</span>
            {entry.title}
          </h3>
          <p>
            {entry.repo} · {entry.kind === 'stack' ? 'Stack' : 'Pull request'} · {entry.trunk}
            {entry.startedAt ? ` · started ${formatExact(entry.startedAt)}` : ''}
          </p>
        </div>
        {open ? (
          <div className="queue-actions">
            {canUp ? (
              <button type="button" className="ghost" onClick={() => void onMove(entry.id, 'up')}>
                Up
              </button>
            ) : null}
            {canDown ? (
              <button type="button" className="ghost" onClick={() => void onMove(entry.id, 'down')}>
                Down
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={() => void onCancel(entry.id)}>
              Cancel
            </button>
          </div>
        ) : null}
      </header>
      {entry.error ? <p className="merge-error">{entry.error}</p> : null}
      <ol className="queue-steps">
        {entry.steps.map((step) => (
          <li key={step.id}>
            <span className={`pill queue ${step.status}`}>{stepLabel(step.status)}</span>
            <a className="external" href={prHref(step.url, host)} target="_blank" rel="noreferrer">
              #{step.number} {step.title}
            </a>
            <span className="meta">
              {step.role === 'restack' ? 'rebase only' : step.headRef}
              {step.detail ? ` · ${step.detail}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {entry.logs.length > 0 ? <QueueLogs logs={entry.logs} /> : null}
    </article>
  )
}

function QueueLogs({ logs }: { logs: MergeLog[] }) {
  const [open, setOpen] = useState(false)
  const count = logs.length === 1 ? '1 line' : `${logs.length} lines`
  return (
    <div className="queue-logs">
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
      {open ? (
        <pre className="queue-log">
          {logs.map((line) => `${line.at.slice(11, 19)}  ${line.message}`).join('\n')}
        </pre>
      ) : null}
    </div>
  )
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
