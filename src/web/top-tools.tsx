import { agentsSummary } from '../shared/agents.ts'
import { queueSummary, type QueueSnapshot } from '../shared/queue.ts'
import type { AgentSessionStatus } from '../shared/types.ts'
import { formatExact } from './format.ts'
import { Roll } from './motion.tsx'
import type { RefreshProgress } from './use-snapshot.ts'
import { Icon } from './icons.tsx'

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
        <Icon name="sync" className={refreshing ? 'refresh-spin' : undefined} />
        {refreshing ? null : <span className={`pip ${freshness(syncedAt, now)}`} />}
      </button>
    </div>
  )
}

export function AgentsButton({ statuses, pressed, onClick }: { statuses: AgentSessionStatus[]; pressed: boolean; onClick: () => void }) {
  const { running, waiting, label } = agentsSummary(statuses)
  return (
    <button type="button" className="tool-btn agents-tool" data-state={running > 0 ? 'active' : undefined} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      <Icon name="agents" />
      {running > 0 ? <Roll className="tool-count" value={running} /> : null}
      {waiting > 0 ? <span className="pip waiting" /> : null}
    </button>
  )
}

export function QueueButton({ queue, pressed, onClick }: { queue: QueueSnapshot | null; pressed: boolean; onClick: () => void }) {
  const { count, held, state, label } = queueSummary(queue?.entries ?? [])
  return (
    <button type="button" className="tool-btn queue-tool" data-state={state} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      <Icon name="queue" />
      {count > 0 ? <span className="tool-count">{count}</span> : null}
      {held > 0 ? <span className="pip held" /> : null}
    </button>
  )
}
