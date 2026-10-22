import { useEffect, useMemo, useState } from 'react'
import { ownersFromRepos, parseRepoName, removalWarning, repoLeaf, repoOwner, type RepoCatalog, type RepoChoice } from '../shared/repos.ts'
import { api, type SyncStatus } from './api.ts'
import { formatExact } from './format.ts'

export function SettingsPage({
  status,
  repos,
  mineSyncedAt,
  reviewSyncedAt,
  syncing,
  onFullSync,
  onAddRepo,
  onRemoveRepo,
}: {
  status: SyncStatus | null
  repos: string[]
  mineSyncedAt: string | null
  reviewSyncedAt: string | null
  syncing: boolean
  onFullSync: () => void
  onAddRepo: (repo: string) => Promise<void>
  onRemoveRepo: (repo: string) => Promise<void>
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
        <h2>Full sync</h2>
        <p>Reloads both lists and reads rulesets again for the repositories you selected.</p>
        <button type="button" className="primary" disabled={syncing || repos.length === 0} onClick={onFullSync}>
          {syncing ? 'Syncing' : 'Full sync'}
        </button>
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
