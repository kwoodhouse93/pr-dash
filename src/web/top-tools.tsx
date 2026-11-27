import { agentsSummary } from '../shared/agents.ts'
import { queueSummary, type QueueSnapshot } from '../shared/queue.ts'
import type { AgentSessionStatus } from '../shared/types.ts'
import { formatExact } from './format.ts'
import { Roll } from './motion.tsx'
import type { RefreshProgress } from './use-snapshot.ts'

// The buttons at the right of the header that say how things stand: the refresh, the agents and the merge queue.

const FRESH_MS = 10 * 60 * 1000
const STALE_MS = 30 * 60 * 1000

function freshness(iso: string | null, now: number): 'fresh' | 'aging' | 'stale' {
  if (!iso) return 'stale'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'stale'
  const age = now - then
  if (age > STALE_MS) return 'stale'
  if (age > FRESH_MS) return 'aging'
  return 'fresh'
}

export function RefreshControl({
  refreshing,
  status,
  progress,
  syncedAt,
  now,
  onRefresh,
}: {
  refreshing: boolean
  status: string
  progress: RefreshProgress | null
  syncedAt: string | null
  now: number
  onRefresh: () => void
}) {
  const text = status && status !== 'Idle' ? status : 'Refreshing'
  const known = progress != null && progress.total > 0
  const label = refreshing ? text : syncedAt ? `Refresh. Last updated ${formatExact(syncedAt)}` : 'Refresh. Not updated yet'
  return (
    <div className="refresh-cluster">
      {refreshing ? (
        <div className="refresh-activity" aria-live="polite">
          <span className="refresh-text" title={text}>
            {text}
          </span>
          {known ? (
            <span
              className="refresh-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              aria-label="Refresh progress"
            >
              <span style={{ width: `${Math.min(100, (progress.completed / progress.total) * 100)}%` }} />
            </span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="tool-btn refresh-tool"
        disabled={refreshing}
        aria-busy={refreshing}
        aria-label={label}
        title={label}
        onClick={onRefresh}
      >
        <SyncArrows spinning={refreshing} />
        {refreshing ? null : <span className={`pip ${freshness(syncedAt, now)}`} />}
      </button>
    </div>
  )
}

export function AgentsButton({ statuses, pressed, onClick }: { statuses: AgentSessionStatus[]; pressed: boolean; onClick: () => void }) {
  const { running, waiting, label } = agentsSummary(statuses)
  return (
    <button type="button" className="tool-btn agents-tool" data-state={running > 0 ? 'active' : undefined} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="9" width="16" height="11" rx="3" />
        <path d="M12 5v4M9 14v1.5M15 14v1.5M2 13.5v3M22 13.5v3" />
        <circle cx="12" cy="3.5" r="1.5" />
      </svg>
      {running > 0 ? <Roll className="tool-count" value={running} /> : null}
      {waiting > 0 ? <span className="pip waiting" /> : null}
    </button>
  )
}

export function QueueButton({ queue, pressed, onClick }: { queue: QueueSnapshot | null; pressed: boolean; onClick: () => void }) {
  const { count, held, state, label } = queueSummary(queue?.entries ?? [])
  return (
    <button type="button" className="tool-btn queue-tool" data-state={state} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </svg>
      {count > 0 ? <span className="tool-count">{count}</span> : null}
      {held > 0 ? <span className="pip held" /> : null}
    </button>
  )
}

function SyncArrows({ spinning }: { spinning: boolean }) {
  return (
    <svg className={spinning ? 'refresh-spin' : undefined} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 16h5v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
