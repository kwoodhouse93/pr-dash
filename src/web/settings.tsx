import type { SyncStatus } from './api.ts'
import { formatExact } from './format.ts'

export function SettingsPage({
  status,
  mineSyncedAt,
  reviewSyncedAt,
  syncing,
  onFullSync,
}: {
  status: SyncStatus | null
  mineSyncedAt: string | null
  reviewSyncedAt: string | null
  syncing: boolean
  onFullSync: () => void
}) {
  const windows = status?.graphql.windows ?? []
  return (
    <div className="settings">
      <section>
        <h2>GitHub</h2>
        <p>
          The list you are looking at refreshes every 3 minutes. Thread replies load after that, and again only when that pull request changes.
          Those refreshes pause while the lowest window has fewer than 200 points left. Refresh on a row reloads just that pull request.
        </p>
        {windows.length === 0 ? (
          <p>
            <strong>Waiting for the next GitHub response</strong>
          </p>
        ) : (
          <ul>
            {windows.map((window) => (
              <li key={window.resetAt}>
                <strong>
                  {window.remaining} of {window.limit}
                </strong>
                {` · resets ${formatExact(window.resetAt)}`}
              </li>
            ))}
          </ul>
        )}
        {status?.graphql.paused && status.graphql.message ? <p>{status.graphql.message}</p> : null}
      </section>
      <section>
        <h2>Lists</h2>
        <ul>
          <li>My PRs · {stamp(mineSyncedAt)}</li>
          <li>Review · {stamp(reviewSyncedAt)}</li>
        </ul>
      </section>
      <section>
        <h2>Rulesets</h2>
        <p>Required checks are read from each repository at most once a day.</p>
        {status && status.rules.length > 0 ? (
          <ul>
            {status.rules.map((rule) => (
              <li key={rule.repo}>
                {rule.repo} · {formatExact(rule.fetchedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p>No rulesets cached yet.</p>
        )}
      </section>
      <section>
        <h2>Full sync</h2>
        <p>Reloads both lists and reads rulesets again.</p>
        <button type="button" className="primary" disabled={syncing} onClick={onFullSync}>
          {syncing ? 'Syncing' : 'Full sync'}
        </button>
      </section>
    </div>
  )
}

function stamp(iso: string | null): string {
  return iso ? formatExact(iso) : 'Not yet'
}
