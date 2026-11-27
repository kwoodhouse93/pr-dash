import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseRepoName, removalWarning, type RepoCatalog, type RepoChoice } from '../shared/repos.ts'
import { DEFAULT_THEME, THEMES, type ThemeId } from '../shared/themes.ts'
import { AgentSettingsPanel } from './agent-settings.tsx'
import { api, type SyncKind, type SyncStatus } from './api.ts'
import { formatAgo, formatExact, formatTime } from './format.ts'
import { Icon } from './icons.tsx'
import { CloseButton } from './menus.tsx'
import { Fold } from './motion.tsx'
import type { PrLinkHost } from './pr-links.tsx'
import { RepoIcon, RepoMarkPicker } from './repo-mark.tsx'
import { dismiss } from './sounds.ts'
import type { RepoMark, Snapshot } from '../shared/types.ts'

/** How many search matches the add box lists before asking for a narrower search. */
const MATCH_LIMIT = 8
/** List refreshes pause below this many points, so the meter turns red there. */
const BUDGET_FLOOR = 200

export function SettingsPage({
  status,
  repos,
  mineSyncedAt,
  reviewSyncedAt,
  onEnqueue,
  onCancelSync,
  onAddRepo,
  onRemoveRepo,
  onRepoMark,
  onAgents,
  t3Origin = null,
  onT3Origin = () => {},
  t3PairPrompt = true,
  initiatives,
  prLinks = 'github',
  onPrLinks = () => {},
  theme = DEFAULT_THEME,
  onTheme = () => {},
  sounds = true,
  onSounds = () => {},
  mergeUnapproved = false,
  onMergeUnapproved = () => {},
}: {
  status: SyncStatus | null
  repos: string[]
  mineSyncedAt: string | null
  reviewSyncedAt: string | null
  onEnqueue: (kind: 'full' | 'rules') => void
  onCancelSync: (id: string) => void
  onAddRepo: (repo: string) => Promise<void>
  onRemoveRepo: (repo: string) => Promise<void>
  /** Saves the icon and colour shown for a repository. Left out, the icon is shown and cannot be changed. */
  onRepoMark?: (repo: string, mark: RepoMark) => Promise<void>
  /** Takes the snapshot after an agent setting changes. Left out, the Agents section is not shown. */
  onAgents?: (snapshot: Snapshot) => void
  /** The T3 Code this browser is paired with, or null. */
  t3Origin?: string | null
  onT3Origin?: (origin: string | null) => void
  /** False once the user chose not to be asked to pair with T3 Code. */
  t3PairPrompt?: boolean
  /** The initiatives editor. Left out, the section is not shown. */
  initiatives?: ReactNode
  prLinks?: PrLinkHost
  onPrLinks?: (host: PrLinkHost) => void
  /** The colour theme in use. */
  theme?: ThemeId
  onTheme?: (theme: ThemeId) => void
  /** Whether buttons click when pressed. */
  sounds?: boolean
  onSounds?: (on: boolean) => void
  /** Whether a pull request's menu offers to merge it without its required approval. */
  mergeUnapproved?: boolean
  onMergeUnapproved?: (on: boolean) => void
}) {
  const [catalog, setCatalog] = useState<RepoCatalog | null>(null)
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [showStored, setShowStored] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [pending, setPending] = useState<RepoChoice | null>(null)
  const [removing, setRemoving] = useState(false)
  const windows = status?.graphql.windows ?? []
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
      if (event.key !== 'Escape' || removing) return
      dismiss()
      setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, removing])

  const known = useMemo(() => new Map((catalog?.repos ?? []).map((row) => [row.name, row])), [catalog])
  const selected = useMemo(
    () => [...repos].sort((a, b) => a.localeCompare(b)).map((name) => known.get(name) ?? { name, selected: true, stored: false, busy: false }),
    [repos, known],
  )
  const stored = useMemo(() => {
    const chosen = new Set(repos)
    return (catalog?.repos ?? []).filter((row) => row.stored && !chosen.has(row.name)).sort((a, b) => a.name.localeCompare(b.name))
  }, [catalog, repos])
  const query = draft.trim().toLowerCase()
  const matches = useMemo(() => {
    const chosen = new Set(repos)
    return (catalog?.repos ?? [])
      .filter((row) => !chosen.has(row.name) && row.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [catalog, repos, query])
  const ruleTimes = new Map((status?.rules ?? []).map((rule) => [rule.repo, rule.fetchedAt]))
  const warning = pending ? removalWarning(pending.name, pending.stored, pending.busy) : null
  const activity = status?.activity ?? null
  const upcoming = status?.queue ?? []
  const history = status?.history ?? []
  const fullQueued = upcoming.some((job) => job.kind === 'full')
  const rulesQueued = upcoming.some((job) => job.kind === 'rules')
  const busy = activity != null || upcoming.length > 0

  function submitDraft() {
    const name = draft.trim()
    if (!name) return
    if (name.includes('/')) void add(name)
    else if (matches.length === 1) void add(matches[0]!.name)
    else setError('Pick a repository from the list, or enter one as owner/name.')
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
      <div className="settings-main">
        <section className="panel">
          <header className="panel-head">
            <h2>Repositories</h2>
            <span className="panel-note">{repos.length === 0 ? 'None selected yet' : `${repos.length} syncing`}</span>
          </header>
          <form
            className="panel-row repo-add"
            onSubmit={(event) => {
              event.preventDefault()
              submitDraft()
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
            }}
          >
            <input
              className="search"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setOpen(true)
                setError(null)
              }}
              onFocus={() => setOpen(true)}
              placeholder="Add a repository: search, or type owner/name"
              aria-label="Add a repository"
              disabled={busyName != null}
            />
            {open && catalog ? (
              // Keeps focus in the search box so a click lands before the list closes.
              <ul className="repo-matches" aria-label="Repositories to add" onMouseDown={(event) => event.preventDefault()}>
                {matches.slice(0, MATCH_LIMIT).map((row) => (
                  <li key={row.name}>
                    <button type="button" onClick={() => void add(row.name)}>
                      <span className="repo-name">{row.name}</span>
                      {row.stored ? <span className="repo-meta">Saved data</span> : null}
                    </button>
                  </li>
                ))}
                {matches.length > MATCH_LIMIT ? (
                  <li className="repo-note">{matches.length - MATCH_LIMIT} more. Keep typing to narrow the list.</li>
                ) : null}
                {matches.length === 0 ? (
                  <li className="repo-note">
                    {query.includes('/') ? 'Not in the list GitHub returned. Press Enter to add it anyway.' : 'No repositories match.'}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </form>
          {error && !pending ? <p className="panel-row repo-error">{error}</p> : null}
          {catalog?.warning ? <p className="panel-row panel-note">{catalog.warning}</p> : null}
          {catalog?.truncated ? (
            <p className="panel-row panel-note">GitHub returned the first 1000 repositories. Add any other as owner/name.</p>
          ) : null}
          <ul aria-label="Repositories syncing">
            {selected.map((row) => {
              const fetchedAt = ruleTimes.get(row.name)
              return (
                <li key={row.name} className="panel-row">
                  {onRepoMark ? <RepoMarkPicker repo={row.name} onPick={onRepoMark} /> : <RepoIcon repo={row.name} />}
                  <span className="repo-name">{row.name}</span>
                  <span className="repo-meta" title={fetchedAt ? formatExact(fetchedAt) : undefined}>
                    {fetchedAt ? `rules read ${formatAgo(fetchedAt)}` : 'rules not read yet'}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${row.name}`}
                    title="Remove"
                    disabled={removing || busyName === row.name}
                    onClick={() => setPending(row)}
                  >
                    <Icon name="x" />
                  </button>
                </li>
              )
            })}
          </ul>
          {stored.length > 0 ? (
            <div className="panel-row panel-note">
              <span className="repo-name">
                {stored.length === 1 ? '1 unselected repository still has saved data' : `${stored.length} unselected repositories still have saved data`}
              </span>
              <button type="button" className="text-btn" aria-expanded={showStored} onClick={() => setShowStored((current) => !current)}>
                {showStored ? 'Hide' : 'Review'}
              </button>
            </div>
          ) : null}
          <Fold open={showStored && stored.length > 0}>
            <ul aria-label="Unselected repositories with saved data">
              {stored.map((row) => (
                <li key={row.name} className="panel-row">
                  <span className="repo-name">{row.name}</span>
                  <button type="button" className="text-btn" disabled={busyName != null} onClick={() => void add(row.name)}>
                    Sync again
                  </button>
                  <button type="button" className="text-btn" onClick={() => setPending(row)}>
                    Delete data
                  </button>
                </li>
              ))}
            </ul>
          </Fold>
        </section>
        {onAgents ? <AgentSettingsPanel repos={repos} onSnapshot={onAgents} t3Origin={t3Origin} onT3Origin={onT3Origin} pairPrompt={t3PairPrompt} /> : null}
        {initiatives ? <section className="panel initiatives">{initiatives}</section> : null}
        <section className="panel">
          <header className="panel-head">
            <h2>Theme</h2>
            <span className="panel-note">Saved in this browser</span>
          </header>
          <div className="themes" role="group" aria-label="Theme">
            {THEMES.map((option) => (
              <button key={option.id} type="button" className="theme-card" aria-pressed={option.id === theme} onClick={() => onTheme(option.id)}>
                {/* Naming the theme here draws the sample in that theme's own colours. */}
                <span className="theme-sample" data-theme={option.id} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {option.label}
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-row setting">
            <h3>Open pull requests in</h3>
            <div className="segmented" role="group" aria-label="Default pull request links">
              <button type="button" aria-pressed={prLinks === 'github'} onClick={() => onPrLinks('github')}>
                GitHub
              </button>
              <button type="button" aria-pressed={prLinks === 'graphite'} onClick={() => onPrLinks('graphite')}>
                Graphite
              </button>
            </div>
          </div>
          <div className="panel-row setting">
            <h3>Button sounds</h3>
            <div className="segmented" role="group" aria-label="Button sounds">
              <button type="button" aria-pressed={sounds} onClick={() => onSounds(true)}>
                On
              </button>
              <button type="button" aria-pressed={!sounds} onClick={() => onSounds(false)}>
                Off
              </button>
            </div>
          </div>
          <div
            className="panel-row setting"
            title="Turns on a menu option to merge a pull request that has not been approved. It does not change how Merge works: an unapproved pull request only merges when you choose that option for it."
          >
            <h3>Allow merge without approval</h3>
            <div className="segmented" role="group" aria-label="Allow merge without approval">
              <button type="button" aria-pressed={mergeUnapproved} onClick={() => onMergeUnapproved(true)}>
                On
              </button>
              <button type="button" aria-pressed={!mergeUnapproved} onClick={() => onMergeUnapproved(false)}>
                Off
              </button>
            </div>
          </div>
        </section>
      </div>
      <aside className="settings-side">
        <section className="panel">
          <header className="panel-head">
            <h2>Status</h2>
          </header>
          <div className="stat">
            <h3>GitHub budget</h3>
            {windows.length === 0 ? <p>Waiting for the next GitHub response</p> : null}
            {windows.map((window) => (
              <div key={window.resetAt} className="budget">
                <div className="stat-line">
                  <span>
                    {window.remaining.toLocaleString('en-GB')} of {window.limit.toLocaleString('en-GB')}
                  </span>
                  <span className="repo-meta" title={formatExact(window.resetAt)}>
                    resets {formatTime(window.resetAt)}
                  </span>
                </div>
                <div className="meter" data-tone={budgetTone(window.remaining, window.limit)}>
                  <i style={{ width: `${percent(window.remaining, window.limit)}%` }} />
                </div>
              </div>
            ))}
            {status?.graphql.paused && status.graphql.message ? <p className="stat-warn">{status.graphql.message}</p> : null}
            <details className="how">
              <summary>
                Lists refresh about every minute. <span className="how-open">How it works</span>
                <span className="how-close">Hide</span>
              </summary>
              <p>
                Refreshes carry on while this tab is in the background. Finished checks stay put when that pull request and its check
                rollup have not changed. Running checks are read again, and each refresh also rereads the checks that were fetched least
                recently. Thread replies load after that, and again only when that pull request changes.
              </p>
              <p>
                Refreshes pause while the lowest window has fewer than {BUDGET_FLOOR} points left. Refresh on a row reloads just that pull
                request.
              </p>
            </details>
          </div>
          <div className="stat">
            <h3>Lists</h3>
            <div className="stat-line">
              <span>My PRs</span>
              <Stamp iso={mineSyncedAt} />
            </div>
            <div className="stat-line">
              <span>Review</span>
              <Stamp iso={reviewSyncedAt} />
            </div>
          </div>
          <div className="stat">
            <h3>Sync</h3>
            <div className="sync-actions">
              <button
                type="button"
                className="primary"
                title="Reload both lists and read rulesets again"
                disabled={fullQueued || repos.length === 0}
                onClick={() => onEnqueue('full')}
              >
                {fullQueued ? 'Full sync queued' : busy ? 'Queue full sync' : 'Full sync'}
              </button>
              <button
                type="button"
                className="ghost"
                title="Read required checks again. They are otherwise read at most once a day."
                disabled={rulesQueued || repos.length === 0}
                onClick={() => onEnqueue('rules')}
              >
                {rulesQueued ? 'Rulesets queued' : busy ? 'Queue ruleset sync' : 'Sync rulesets'}
              </button>
            </div>
            {activity == null && upcoming.length === 0 ? (
              <p>Nothing running.</p>
            ) : (
              <ul className="sync-list">
                {activity ? (
                  <li>
                    <div className="stat-line">
                      <span className="dotted" data-tone="running">
                        <span>
                          {syncKindLabel(activity.kind)}
                          {status && status.message !== 'Idle' ? ` · ${status.message}` : ''}
                          {status && status.total > 0 ? ` · ${status.completed} of ${status.total}` : ''}
                        </span>
                      </span>
                      <button type="button" className="text-btn" aria-label={`Cancel ${syncKindLabel(activity.kind)}`} onClick={() => onCancelSync(activity.id)}>
                        Cancel
                      </button>
                    </div>
                    {status && status.total > 0 ? (
                      <div className="meter" data-tone="running">
                        <i style={{ width: `${percent(status.completed, status.total)}%` }} />
                      </div>
                    ) : null}
                  </li>
                ) : null}
                {upcoming.map((job) => (
                  <li key={job.id} className="stat-line">
                    <span className="dotted" data-tone="waiting">
                      <span>Up next · {syncKindLabel(job.kind)}</span>
                    </span>
                    <button type="button" className="text-btn" aria-label={`Cancel ${syncKindLabel(job.kind)}`} onClick={() => onCancelSync(job.id)}>
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="stat">
            <h3>Recent</h3>
            {history.length === 0 ? (
              <p>No full or ruleset syncs yet.</p>
            ) : (
              <ul className="sync-list">
                {history.map((entry) => (
                  <li key={entry.id} className="stat-line">
                    <span className="dotted" data-tone={entry.outcome}>
                      <span>
                        {syncKindLabel(entry.kind)} · {historyLabel(entry)}
                      </span>
                    </span>
                    <Stamp iso={entry.finishedAt} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </aside>
      {pending && warning ? (
        <div
          className="modal-back"
          onMouseDown={() => {
            if (removing) return
            dismiss()
            setPending(null)
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
            <header className="modal-head">
              <h3 id="remove-repo-title">{warning.title}</h3>
              {removing ? null : <CloseButton onClose={() => setPending(null)} />}
            </header>
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

function Stamp({ iso }: { iso: string | null }) {
  if (!iso) return <span className="repo-meta">Not yet</span>
  return (
    <span className="repo-meta" title={formatExact(iso)}>
      {formatAgo(iso)}
    </span>
  )
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
}

function budgetTone(remaining: number, limit: number): 'ok' | 'low' | 'out' {
  if (remaining < BUDGET_FLOOR) return 'out'
  return remaining / limit < 0.4 ? 'low' : 'ok'
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
