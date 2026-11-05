import { useEffect, useMemo, useState } from 'react'
import { ownersFromRepos, parseRepoName, removalWarning, repoLeaf, repoOwner, type RepoCatalog, type RepoChoice } from '../shared/repos.ts'
import { api, type SyncKind, type SyncStatus } from './api.ts'
import { formatExact } from './format.ts'
import type { PrLinkHost } from './pr-links.tsx'

export function SettingsPage({
  status,
  repos,
  mineSyncedAt,
  reviewSyncedAt,
  onEnqueue,
  onCancelSync,
  onAddRepo,
  onRemoveRepo,
  prLinks = 'github',
  onPrLinks = () => {},
}: {
  status: SyncStatus | null
  repos: string[]
  mineSyncedAt: string | null
  reviewSyncedAt: string | null
  onEnqueue: (kind: 'full' | 'rules') => void
  onCancelSync: (id: string) => void
  onAddRepo: (repo: string) => Promise<void>
  onRemoveRepo: (repo: string) => Promise<void>
  prLinks?: PrLinkHost
  onPrLinks?: (host: PrLinkHost) => void
}) {
  const [catalog, setCatalog] = useState<RepoCatalog | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [pending, setPending] = useState<RepoChoice | null>(null)
  const [removing, setRemoving] = useState(false)
  const windows = status?.graphql.windows ?? []
  const selected = new Set(repos)
  const rules = (status?.rules ?? []).filter((rule) => selected.has(rule.repo))
  const selectionKey = repos.join('|')

  useEffect(() => {
    let cancel = false
    void api.repos().then((next) => {
      if (!cancel) setCatalog(next)
    }).catch((caught) => {
      if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not list repositories')
    })
    return () => {
      cancel = true
    }
  }, [selectionKey])

  useEffect(() => {
    if (!pending) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !removing) setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, removing])

  const rows = useMemo(() => {
    const list = catalog ? catalog.repos : repos.map((name) => ({ name, selected: true, stored: false, busy: false }))
    const rank = (row: RepoChoice) => (row.selected ? 0 : row.stored ? 1 : 2)
    return [...list].sort((a, b) => rank(a) - rank(b) || repoLeaf(a.name).localeCompare(repoLeaf(b.name)))
  }, [catalog, repos])
  const owners = useMemo(() => ownersFromRepos(rows, catalog?.viewer ?? null), [rows, catalog?.viewer])
  const query = filter.trim().toLowerCase()
  const visibleOwners = query ? owners.filter((item) => item.name.toLowerCase().includes(query)) : owners
  const visibleRepos = rows.filter((row) => repoOwner(row.name) === owner && (!query || repoLeaf(row.name).toLowerCase().includes(query)))
  const warning = pending ? removalWarning(pending.name, pending.stored, pending.busy) : null
  const activity = status?.activity ?? null
  const upcoming = status?.queue ?? []
  const history = status?.history ?? []
  const fullQueued = upcoming.some((job) => job.kind === 'full')
  const rulesQueued = upcoming.some((job) => job.kind === 'rules')
  const busy = activity != null || upcoming.length > 0

  function chooseOwner(name: string) {
    setOwner(name)
    setFilter('')
    setError(null)
  }

  function addNamed(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (trimmed.includes('/') || !owner) void add(trimmed)
    else void add(`${owner}/${trimmed}`)
  }

  async function add(name: string) {
    setError(null)
    let repo = name
    try {
      repo = parseRepoName(name)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enter a repository as owner/name.')
      return
    }
    setBusyName(repo)
    try {
      await onAddRepo(repo)
      setDraft('')
      setCatalog(await api.repos())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that repository')
    } finally {
      setBusyName(null)
    }
  }

  async function confirmRemove() {
    if (!pending || !warning?.confirm) return
    setRemoving(true)
    setError(null)
    try {
      await onRemoveRepo(pending.name)
      setPending(null)
      setCatalog(await api.repos())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove that repository')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="settings">
      <section>
        <h2>Pull request links</h2>
        <p>
          Titles, numbers, the merge queue, and feedback open in the host you pick. The Open column still has both.
          A review thread, inline comment, conversation comment, or review summary opens that same item on Graphite when Graphite is selected.
        </p>
        <div className="segmented" role="group" aria-label="Default pull request links">
          <button type="button" aria-pressed={prLinks === 'github'} onClick={() => onPrLinks('github')}>
            GitHub
          </button>
          <button type="button" aria-pressed={prLinks === 'graphite'} onClick={() => onPrLinks('graphite')}>
            Graphite
          </button>
        </div>
      </section>
      <section>
        <h2>Repositories</h2>
        <p>
          Choose an owner, then the repositories to sync.
          {repos.length === 0 ? ' None are selected yet.' : ` ${repos.length} selected.`}
        </p>
        <p>Removing a repository deletes the pull requests and other data this dashboard has stored for it. GitHub is not changed.</p>
        {catalog?.warning ? <p>{catalog.warning}</p> : null}
        {catalog?.truncated ? <p>GitHub returned the first 1000 repositories. Add any other as owner/name.</p> : null}
        {error && !pending ? <p className="repo-error">{error}</p> : null}
        {owner ? (
          <div className="repo-back">
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setOwner(null)
                setFilter('')
              }}
            >
              All owners
            </button>
            <strong>{owner}</strong>
          </div>
        ) : null}
        <input
          className="search repo-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={owner ? 'Find a repository' : 'Find an owner'}
          aria-label={owner ? 'Find a repository' : 'Find an owner'}
        />
        {owner ? (
          <ul className="repo-pick" aria-label={`Repositories for ${owner}`}>
            {catalog && visibleRepos.length === 0 ? <li className="repo-note">No repositories match.</li> : null}
            {visibleRepos.map((row) => (
              <li key={row.name}>
                <label>
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={busyName === row.name || removing}
                    onChange={(event) => {
                      if (event.target.checked) void add(row.name)
                      else setPending(row)
                    }}
                  />
                  <span>{repoLeaf(row.name)}</span>
                </label>
                {row.stored && !row.selected ? <span className="repo-meta">Saved from an earlier sync</span> : null}
                {row.stored && !row.selected ? (
                  <button type="button" className="text-btn" onClick={() => setPending(row)}>
                    Delete data
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="repo-pick" aria-label="Owners">
            {catalog == null && rows.length === 0 ? <li className="repo-note">Loading repositories…</li> : null}
            {catalog && visibleOwners.length === 0 ? <li className="repo-note">No owners match.</li> : null}
            {visibleOwners.map((item) => (
              <li key={item.name}>
                <button type="button" className="owner" onClick={() => chooseOwner(item.name)}>
                  <span className="owner-name">{item.name}</span>
                  {item.selected > 0 ? <span className="repo-meta">{item.selected} selected</span> : null}
                  {item.stored > 0 ? <span className="repo-meta">Saved data</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="repo-add"
          onSubmit={(event) => {
            event.preventDefault()
            addNamed(draft)
          }}
        >
          <input
            className="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={owner ? 'repository name' : 'owner/name'}
            aria-label={owner ? `Repository to add under ${owner}` : 'Repository to add'}
          />
          <button type="submit" className="ghost" disabled={busyName != null}>
            Add
          </button>
        </form>
      </section>
      <section>
        <h2>GitHub</h2>
        <p>
          The list you are looking at refreshes about every minute, including while this tab is in the background. Finished checks stay
          put when that pull request and its check rollup have not changed. Running checks are read again, and each refresh also rereads
          the checks that were fetched least recently. Thread replies load after that, and again only when that pull request changes.
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
        <p>Required checks are read from each selected repository at most once a day.</p>
        {rules.length > 0 ? (
          <ul>
            {rules.map((rule) => (
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
        <h2>Sync</h2>
        <p>
          Full sync reloads both lists and reads rulesets again for the repositories you selected. Sync rulesets reloads those rules only.
          If a sync is already running, the next one waits until it finishes.
        </p>
        <div className="sync-actions">
          <button type="button" className="primary" disabled={fullQueued || repos.length === 0} onClick={() => onEnqueue('full')}>
            {fullQueued ? 'Full sync queued' : busy ? 'Queue full sync' : 'Full sync'}
          </button>
          <button type="button" className="ghost" disabled={rulesQueued || repos.length === 0} onClick={() => onEnqueue('rules')}>
            {rulesQueued ? 'Rulesets queued' : busy ? 'Queue ruleset sync' : 'Sync rulesets'}
          </button>
        </div>
        <h3 className="sync-sub">Queue</h3>
        {activity == null && upcoming.length === 0 ? (
          <p>Nothing running.</p>
        ) : (
          <ul className="sync-list">
            {activity ? (
              <li className="sync-row">
                <span>
                  <strong>Running</strong>
                  {` · ${syncKindLabel(activity.kind)}`}
                  {status && status.message !== 'Idle' ? ` · ${status.message}` : ''}
                  {status && status.total > 0 ? ` · ${status.completed} of ${status.total}` : ''}
                </span>
                <button type="button" className="text-btn" aria-label={`Cancel ${syncKindLabel(activity.kind)}`} onClick={() => onCancelSync(activity.id)}>
                  Cancel
                </button>
              </li>
            ) : null}
            {upcoming.map((job) => (
              <li key={job.id} className="sync-row">
                <span>Up next · {syncKindLabel(job.kind)}</span>
                <button type="button" className="text-btn" aria-label={`Cancel ${syncKindLabel(job.kind)}`} onClick={() => onCancelSync(job.id)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="sync-sub">Recent syncs</h3>
        {history.length === 0 ? (
          <p>No full or ruleset syncs yet.</p>
        ) : (
          <ul className="sync-list">
            {history.map((entry) => (
              <li key={entry.id}>
                {syncKindLabel(entry.kind)} · {historyLabel(entry)} · {formatExact(entry.finishedAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {pending && warning ? (
        <div
          className="modal-back"
          onMouseDown={() => {
            if (!removing) setPending(null)
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-repo-title"
            aria-describedby="remove-repo-body"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 id="remove-repo-title">{warning.title}</h3>
            <p id="remove-repo-body">{warning.body}</p>
            {error ? <p className="repo-error">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="ghost" autoFocus disabled={removing} onClick={() => setPending(null)}>
                {warning.confirm ? 'Cancel' : 'Close'}
              </button>
              {warning.confirm ? (
                <button type="button" className="danger" disabled={removing} onClick={() => void confirmRemove()}>
                  {removing ? 'Removing' : warning.confirm}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function stamp(iso: string | null): string {
  return iso ? formatExact(iso) : 'Not yet'
}

function syncKindLabel(kind: SyncKind): string {
  switch (kind) {
    case 'full':
      return 'Full sync'
    case 'rules':
      return 'Rulesets'
    case 'list':
      return 'List refresh'
    case 'pull':
      return 'Pull request'
    case 'threads':
      return 'Thread replies'
  }
}

function historyLabel(entry: { outcome: 'done' | 'failed' | 'cancelled'; message: string }): string {
  if (entry.outcome === 'failed') return `Failed · ${entry.message}`
  if (entry.outcome === 'cancelled') return entry.message === 'Cancelled' ? 'Cancelled' : entry.message
  return entry.message === 'Finished' ? 'Done' : entry.message
}
