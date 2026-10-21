import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collectHolds, mergeHolds, reconcileHolds, withoutHolds, type CheckHold } from '../shared/ci.ts'
import type { FeedbackCounts } from '../shared/feedback.ts'
import { rowMarks } from '../shared/queue.ts'
import type { QueueSnapshot } from '../shared/queue.ts'
import { DEFAULT_FILTERS, type Filters, type Snapshot, type SortKey } from '../shared/types.ts'
import { cursorLinks } from '../shared/cursor.ts'
import { buildOutline, needsAttention, outlineEmpty, prMatches } from '../shared/view.ts'
import { api } from './api.ts'
import { ManageInitiatives } from './editors.tsx'
import { formatExact, repoColors } from './format.ts'
import { ClickCard, MenuProvider } from './menus.tsx'
import { loadPreferences, savePreferences, type DashboardPage } from './prefs.ts'
import { MergeQueuePage } from './queue.tsx'
import { SettingsPage } from './settings.tsx'
import { PrTable } from './table.tsx'
import { Toasts, clearActionError, dismissToast, toastError, toastSticky, toastSuccess, toastWarning } from './toasts.tsx'
import type { SyncStatus } from './api.ts'

const REFRESH_MS = 3 * 60 * 1000
const FRESH_MS = 10 * 60 * 1000
const STALE_MS = 30 * 60 * 1000

type RefreshProgress = { completed: number; total: number }

export function App() {
  const [prefs, setPrefs] = useState(loadPreferences)
  const [data, setData] = useState<Snapshot | null>(null)
  const [booting, setBooting] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [progress, setProgress] = useState<RefreshProgress | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [holds, setHolds] = useState<Map<string, CheckHold[]>>(() => new Map())
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const applyId = useRef(0)
  const mergedKeys = useRef(new Set<string>())
  const seenQueue = useRef(new Set<string>())
  const pageRef = useRef<DashboardPage>(prefs.page)
  pageRef.current = prefs.page
  const refreshedAt = useRef<{ mine: number; review: number }>({ mine: 0, review: 0 })
  const previousPage = useRef(prefs.page)

  function adopt(snap: Snapshot): Snapshot {
    const reviewPullRequests = snap.reviewPullRequests ?? []
    if (mergedKeys.current.size === 0) return { ...snap, reviewPullRequests }
    const keep = (pr: Snapshot['pullRequests'][number]) => !mergedKeys.current.has(pr.key)
    return {
      ...snap,
      pullRequests: snap.pullRequests.filter(keep),
      reviewPullRequests: reviewPullRequests.filter(keep),
    }
  }

  useEffect(() => savePreferences(prefs), [prefs])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setHolds((current) => {
      if (current.size === 0) return current
      const byKey = new Map(
        [...(data?.pullRequests ?? []), ...(data?.reviewPullRequests ?? [])].map((pr) => [pr.key, pr]),
      )
      let changed = false
      const next = new Map<string, CheckHold[]>()
      for (const [key, list] of current) {
        const pr = byKey.get(key)
        const kept = pr ? reconcileHolds(list, pr.checks) : []
        if (kept.length !== list.length) changed = true
        if (kept.length > 0) next.set(key, kept)
      }
      if (!changed && next.size === current.size) return current
      return next
    })
  }, [data])

  async function refresh(options: { force?: boolean; focus?: 'mine' | 'review'; full?: boolean; feedback?: 'if-ran' | 'always' } = {}) {
    const page = pageRef.current
    const focus = options.focus ?? (page === 'review' ? 'review' : 'mine')
    const listed = page === 'mine' || page === 'review'
    const feedback = options.feedback ?? 'if-ran'
    if (!options.full && !listed && !options.force) return false
    const recent = !options.force && !options.full && Date.now() - refreshedAt.current[focus] < REFRESH_MS
    if (recent) {
      if (feedback === 'always') await showFeedback(focus)
      return false
    }
    const id = ++applyId.current
    setRefreshing(true)
    clearActionError()
    setStatus('Starting refresh')
    setProgress(null)
    const started = Date.now()
    const poll = window.setInterval(() => {
      void api.snapshot().then((snap) => {
        if (id === applyId.current) setData(adopt(snap))
      }).catch(() => undefined)
    }, 800)
    try {
      const snap = await api.refresh(focus, options.full === true)
      if (options.full) {
        refreshedAt.current.mine = started
        refreshedAt.current.review = started
      } else {
        refreshedAt.current[focus] = started
      }
      if (id === applyId.current) setData(adopt(snap))
      if (id === applyId.current) {
        try {
          if (options.full) {
            await loadFeedback('mine')
            if (id === applyId.current) await loadFeedback('review')
          } else {
            await loadFeedback(focus)
          }
        } catch (caught) {
          if (id === applyId.current) toastError(caught instanceof Error ? caught.message : 'Could not load thread replies')
        }
      }
      return true
    } catch (caught) {
      if (!options.full) refreshedAt.current[focus] = 0
      if (id === applyId.current) toastError(caught instanceof Error ? caught.message : 'Refresh failed')
      return false
    } finally {
      window.clearInterval(poll)
      if (id === applyId.current) setRefreshing(false)
    }
  }

  async function showFeedback(focus: 'mine' | 'review') {
    const id = ++applyId.current
    setRefreshing(true)
    setStatus('Reading thread replies')
    setProgress(null)
    try {
      await loadFeedback(focus)
    } catch (caught) {
      if (id === applyId.current) toastError(caught instanceof Error ? caught.message : 'Could not load thread replies')
    } finally {
      if (id === applyId.current) setRefreshing(false)
    }
  }

  async function loadFeedback(which: 'mine' | 'review') {
    const id = applyId.current
    for (let step = 0; step < 30; step += 1) {
      const result = await api.feedback(which)
      if (id !== applyId.current) return
      setData(adopt(result.snapshot))
      if (result.pending === 0 || result.paused) return
    }
  }

  async function mutate(work: () => Promise<Snapshot>) {
    const id = ++applyId.current
    clearActionError()
    try {
      const snap = await work()
      if (id === applyId.current) setData(adopt(snap))
    } catch (caught) {
      if (id === applyId.current) toastError(caught instanceof Error ? caught.message : 'Could not save that change')
      throw caught
    } finally {
      if (id === applyId.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const snap = await api.snapshot()
        if (!cancel) setData(adopt(snap))
      } catch (caught) {
        if (!cancel) toastError(caught instanceof Error ? caught.message : 'Could not load the saved snapshot')
      } finally {
        if (!cancel) setBooting(false)
      }
      const page = pageRef.current
      if (page === 'mine' || page === 'review') await refresh({ force: true })
    })()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const page = pageRef.current
      if (page !== 'mine' && page !== 'review') return
      void refresh()
    }, 30_000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (previousPage.current === prefs.page) return
    previousPage.current = prefs.page
    if (prefs.page !== 'mine' && prefs.page !== 'review') return
    void refresh({ feedback: 'always' })
  }, [prefs.page])

  useEffect(() => {
    let cancel = false
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void api.mergeQueue().then((next) => {
        if (cancel) return
        const done = new Set(
          next.history.filter((entry) => entry.status === 'done' || entry.status === 'cancelled').map((entry) => entry.id),
        )
        const finished = [...seenQueue.current].some((id) => done.has(id))
        seenQueue.current = new Set(next.entries.map((entry) => entry.id))
        setQueue(next)
        if (finished) void refresh({ force: true, focus: 'mine' })
      }).catch(() => undefined)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (prefs.page !== 'settings') return
    let cancel = false
    const tick = () => {
      void api.status().then((next) => {
        if (!cancel) setSync(next)
      }).catch(() => undefined)
    }
    tick()
    const timer = window.setInterval(tick, 2000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [prefs.page])

  useEffect(() => {
    if (!refreshing) return
    const timer = window.setInterval(() => {
      void api.status().then((next) => {
        setSync(next)
        if (next.message !== 'Idle') setStatus(next.message)
        if (next.total > 0) setProgress({ completed: next.completed, total: next.total })
      }).catch(() => undefined)
    }, 400)
    return () => window.clearInterval(timer)
  }, [refreshing])

  const linearHint = Boolean(
    data &&
    !data.linearConfigured &&
    [...data.pullRequests, ...(data.reviewPullRequests ?? [])].some((pr) => pr.linearIssues.length > 0),
  )

  useEffect(() => {
    if (!data?.warning) {
      dismissToast('snapshot-warning')
      return
    }
    toastWarning(data.warning, 'snapshot-warning')
  }, [data?.warning])

  useEffect(() => {
    if (!linearHint) {
      dismissToast('linear-setup')
      return
    }
    toastSticky(
      'Set LINEAR_API_KEY to load Linear status, assignee, and project. Issue titles still come from GitHub, and initiatives do not need Linear.',
      'linear-setup',
    )
  }, [linearHint])

  useEffect(() => {
    if (queue?.paused && queue.pauseReason) {
      toastSticky(`Queue paused. ${queue.pauseReason}`, 'queue-paused', 'warning')
    } else {
      dismissToast('queue-paused')
    }
  }, [queue?.paused, queue?.pauseReason])

  const page = prefs.page
  const mine = data?.pullRequests ?? []
  const review = data?.reviewPullRequests ?? []
  const prs = page === 'review' ? review : mine
  const initiatives = data?.initiatives ?? []
  const prByKey = useMemo(() => new Map(prs.map((pr) => [pr.key, pr])), [prs])
  const outline = useMemo(
    () => buildOutline(prs, initiatives, prefs.filters, prefs.sort, page === 'review' ? 'reviewer' : 'author', prefs.byIssue),
    [prs, initiatives, prefs, page],
  )
  const repos = useMemo(() => {
    const names = [...new Set(prs.map((pr) => pr.repo))]
    if (prefs.filters.repo && !names.includes(prefs.filters.repo)) names.push(prefs.filters.repo)
    return names.sort()
  }, [prs, prefs.filters.repo])
  const colors = useMemo(() => repoColors(repos), [repos])
  const visible = !outlineEmpty(outline)
  const reviewBadge = review.filter((pr) => pr.reviewPending || needsAttention(pr, 'reviewer')).length
  const listPage = page === 'mine' || page === 'review'
  const filtersOn = JSON.stringify(prefs.filters) !== JSON.stringify(DEFAULT_FILTERS)
  const matched = useMemo(() => {
    const names = new Map(initiatives.map((initiative) => [initiative.id, initiative.name]))
    const attention = page === 'review' ? 'reviewer' : 'author'
    return prs.filter((pr) => prMatches(pr, prefs.filters, names, attention)).length
  }, [prs, initiatives, prefs.filters, page])
  const noun = page === 'review' ? 'to review' : 'open'
  const countLabel = filtersOn ? `${matched}/${prs.length} ${noun}` : `${prs.length} ${noun}`
  const syncedAt = page === 'review' ? (data?.reviewSyncedAt ?? data?.syncedAt ?? null) : (data?.mineSyncedAt ?? data?.syncedAt ?? null)

  const applyFeedback = useCallback((key: string, counts: FeedbackCounts) => {
    setData((current) => {
      if (!current) return current
      const patch = (pr: Snapshot['pullRequests'][number]) =>
        pr.key === key ? { ...pr, ...counts, feedbackAt: pr.updatedAt } : pr
      return {
        ...current,
        pullRequests: current.pullRequests.map(patch),
        reviewPullRequests: current.reviewPullRequests.map(patch),
      }
    })
  }, [])

  function patchFilters(patch: Partial<Filters>) {
    setPrefs((current) => ({ ...current, filters: { ...current.filters, ...patch } }))
  }

  async function changeQueue(work: () => Promise<QueueSnapshot>, refreshAfter = false) {
    clearActionError()
    try {
      setQueue(await work())
      if (refreshAfter) void refresh({ force: true, focus: 'mine' })
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : 'Could not update the merge queue')
    }
  }

  function chooseSort(key: SortKey) {
    setPrefs((current) => {
      if (current.sort.key === key) {
        return { ...current, sort: { key, dir: current.sort.dir === 'asc' ? 'desc' : 'asc' } }
      }
      const dir = key === 'title' || key === 'repo' ? 'asc' : 'desc'
      return { ...current, sort: { key, dir } }
    })
  }

  return (
    <MenuProvider>
      <Toasts />
      <div className="app">
        <header className="top">
          <div className="top-row">
            <nav className="nav">
              <button type="button" className="text-btn" aria-pressed={page === 'mine'} onClick={() => setPrefs((current) => ({ ...current, page: 'mine' }))}>
                My PRs
              </button>
              <button type="button" className="text-btn" aria-pressed={page === 'review'} onClick={() => setPrefs((current) => ({ ...current, page: 'review' }))}>
                Review
                {reviewBadge > 0 ? <span className="nav-count">{reviewBadge}</span> : null}
              </button>
              <button type="button" className="text-btn" aria-pressed={page === 'queue'} onClick={() => setPrefs((current) => ({ ...current, page: 'queue' }))}>
                Merge queue
                {queue && queue.entries.length > 0 ? <span className="nav-count">{queue.entries.length}</span> : null}
              </button>
              <button type="button" className="text-btn" aria-pressed={page === 'settings'} onClick={() => setPrefs((current) => ({ ...current, page: 'settings' }))}>
                Settings
              </button>
            </nav>
            {page === 'settings' ? null : (
              <RefreshControl
                refreshing={refreshing}
                status={status}
                progress={progress}
                syncedAt={syncedAt}
                now={now}
                onRefresh={() => void refresh({ force: true })}
              />
            )}
          </div>
          <div className="filters" hidden={!listPage}>
            <input
              className="search"
              value={prefs.filters.query}
              onChange={(event) => patchFilters({ query: event.target.value })}
              placeholder={page === 'review' ? 'Title, author, repo, number, issue' : 'Title, repo, number, issue'}
              aria-label="Filter pull requests"
            />
            <select
              className="select"
              aria-label="Repository"
              value={prefs.filters.repo ?? ''}
              onChange={(event) => patchFilters({ repo: event.target.value || null })}
            >
              <option value="">All repos</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo.split('/')[1]}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="CI"
              value={prefs.filters.ci}
              onChange={(event) => patchFilters({ ci: event.target.value as Filters['ci'] })}
            >
              <option value="all">All CI</option>
              <option value="red">Required failed</option>
              <option value="yellow">Optional failed</option>
              <option value="pending">Running</option>
              <option value="green">Passed</option>
              <option value="none">No CI</option>
            </select>
            <select
              className="select"
              aria-label="Review"
              value={prefs.filters.review}
              onChange={(event) => patchFilters({ review: event.target.value as Filters['review'] })}
            >
              <option value="all">All reviews</option>
              <option value="unmet">Review required</option>
              <option value="met">Requirements met</option>
              <option value="human">Human approved</option>
              <option value="changes">Changes requested</option>
              <option value="none">No approval</option>
            </select>
            <select
              className="select"
              aria-label="Initiative"
              value={prefs.filters.initiativeId ?? ''}
              onChange={(event) => patchFilters({ initiativeId: event.target.value || null })}
            >
              <option value="">All initiatives</option>
              <option value="none">Untagged</option>
              {initiatives.map((initiative) => (
                <option key={initiative.id} value={initiative.id}>
                  {initiative.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost"
              aria-pressed={prefs.filters.awaitingOnly}
              onClick={() => patchFilters({ awaitingOnly: !prefs.filters.awaitingOnly })}
            >
              {page === 'review' ? 'Unread' : 'Awaiting you'}
            </button>
            <button
              type="button"
              className="ghost"
              aria-pressed={prefs.filters.hideDrafts}
              onClick={() => patchFilters({ hideDrafts: !prefs.filters.hideDrafts })}
            >
              Hide drafts
            </button>
            <button
              type="button"
              className="ghost"
              aria-pressed={prefs.byIssue}
              title="Show Linear issues, with pull requests under each one"
              onClick={() => setPrefs((current) => ({ ...current, byIssue: !current.byIssue }))}
            >
              By issue
            </button>
            {filtersOn ? (
              <button type="button" className="text-btn" onClick={() => patchFilters(DEFAULT_FILTERS)}>
                Clear filters
              </button>
            ) : null}
            <ClickCard id="manage-initiatives" className="ghost" label="Initiatives">
              <ManageInitiatives
                initiatives={initiatives}
                onCreate={(name) => mutate(() => api.createInitiative(name))}
                onRename={(id, name) => mutate(() => api.renameInitiative(id, name))}
                onDelete={(id) => mutate(() => api.deleteInitiative(id))}
              />
            </ClickCard>
            <span className="filter-count">{countLabel}</span>
          </div>
        </header>
        <div className="scroll">
          {page === 'settings' ? (
            <SettingsPage
              status={sync}
              mineSyncedAt={data?.mineSyncedAt ?? null}
              reviewSyncedAt={data?.reviewSyncedAt ?? null}
              syncing={refreshing}
              onFullSync={() => {
                const focus = pageRef.current === 'review' ? 'review' : 'mine'
                void refresh({ force: true, full: true, focus }).then(async () => {
                  setSync(await api.status().catch(() => null))
                })
              }}
            />
          ) : null}
          {page === 'queue' ? (
            <MergeQueuePage
              queue={queue}
              onCancel={(id) => changeQueue(() => api.cancelMerge(id), true)}
              onMove={(id, direction) => changeQueue(() => api.moveMerge(id, direction))}
            />
          ) : null}
          {listPage && booting && prs.length === 0 ? <div className="empty">Loading saved pull requests…</div> : null}
          {listPage && !booting && prs.length === 0 && refreshing ? <div className="empty">{status}</div> : null}
          {page === 'mine' && !booting && prs.length === 0 && !refreshing ? (
            <div className="empty">
              <h2>No open pull requests</h2>
              <p>This view is pull requests you authored. Refresh again after the next one is open.</p>
            </div>
          ) : null}
          {page === 'review' && !booting && prs.length === 0 && !refreshing ? (
            <div className="empty">
              <h2>No pull requests to review</h2>
              <p>This view is open pull requests that request your review, including your teams, and open pull requests you have already reviewed.</p>
            </div>
          ) : null}
          {listPage && prs.length > 0 && !visible ? (
            <div className="empty">
              <h2>Nothing matches</h2>
              <p>Clear a filter to see the rest of the outline.</p>
            </div>
          ) : null}
          {listPage && prs.length > 0 && visible ? (
            <PrTable
              mode={page === 'review' ? 'review' : 'mine'}
              outline={outline}
              sort={prefs.sort}
              initiatives={initiatives}
              prByKey={prByKey}
              repoColor={colors}
              expanded={new Set(prefs.expanded)}
              collapsed={new Set(prefs.collapsed)}
              queueByKey={rowMarks(queue?.entries ?? [])}
              onSort={chooseSort}
              onToggle={(id) =>
                setPrefs((current) => ({
                  ...current,
                  expanded: current.expanded.includes(id)
                    ? current.expanded.filter((item) => item !== id)
                    : [...current.expanded, id],
                }))
              }
              onToggleSection={(id) =>
                setPrefs((current) => ({
                  ...current,
                  collapsed: current.collapsed.includes(id)
                    ? current.collapsed.filter((item) => item !== id)
                    : [...current.collapsed, id],
                }))
              }
              onAssign={(initiativeId, keys, action) => mutate(() => api.assign(initiativeId, keys, action))}
              onCreateAssigned={async (name, keys) => {
                const before = new Set(initiatives.map((initiative) => initiative.id))
                await mutate(async () => {
                  const snap = await api.createInitiative(name)
                  const created = snap.initiatives.find((initiative) => !before.has(initiative.id))
                  if (!created) return snap
                  return api.assign(created.id, keys, 'add')
                })
              }}
              byIssue={prefs.byIssue}
              linearConfigured={Boolean(data?.linearConfigured)}
              viewer={data?.viewer ?? null}
              onFeedback={applyFeedback}
              onUpdateIssue={(identifier, patch) => mutate(() => api.updateLinearIssue(identifier, patch))}
              onMerge={async (key) => {
                await api.merge(key)
                mergedKeys.current.add(key)
                setData((current) => (current ? adopt(current) : current))
              }}
              onQueue={async (key) => {
                setQueue(await api.enqueue(key, 'pr'))
              }}
              onStackMerge={async (key) => {
                setQueue(await api.enqueue(key, 'downstack'))
              }}
              holds={holds}
              onRerun={async (keys, mode) => {
                const keySet = new Set(keys)
                const targeted = prs.filter((pr) => keySet.has(pr.key))
                const optimistic = collectHolds(targeted, mode, null)
                setHolds((current) => mergeHolds(current, optimistic))
                try {
                  const result = await api.rerun(keys, mode)
                  const restarted = new Set(result.runs.map((run) => `${run.repo}#${run.runId}`))
                  const confirmed = collectHolds(targeted, mode, restarted)
                  setHolds((current) => mergeHolds(withoutHolds(current, optimistic), confirmed))
                  const text = result.errors.length
                    ? `Reran ${result.reran}. ${result.errors[0]}`
                    : `Reran ${result.reran} workflow${result.reran === 1 ? '' : 's'}.`
                  if (result.errors.length) toastWarning(text)
                  else toastSuccess(text)
                  void refresh({ force: true })
                  return text
                } catch (caught) {
                  setHolds((current) => withoutHolds(current, optimistic))
                  throw caught
                }
              }}
              onRebase={async (key) => {
                try {
                  const snap = await api.rebase(key)
                  ++applyId.current
                  setData(adopt(snap))
                } finally {
                  void refresh({ force: true })
                }
              }}
              onRefreshPr={async (key) => {
                const snap = await api.refreshPull(key)
                ++applyId.current
                setData(adopt(snap))
              }}
              onResolveConflictWithCursor={async (key) => {
                const snap = await api.resolveConflictWithCursor(key)
                ++applyId.current
                setData(adopt(snap))
                const session = [...snap.pullRequests, ...(snap.reviewPullRequests ?? [])].find((item) => item.key === key)?.cursorSession
                if (!session) throw new Error('Cursor started without a session link.')
                return { url: cursorLinks(session.agentId).webUrl }
              }}
            />
          ) : null}
        </div>
      </div>
    </MenuProvider>
  )
}

function freshness(iso: string | null, now: number): 'fresh' | 'aging' | 'stale' {
  if (!iso) return 'stale'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'stale'
  const age = now - then
  if (age > STALE_MS) return 'stale'
  if (age > FRESH_MS) return 'aging'
  return 'fresh'
}

function RefreshControl({
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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [open])
  const when = syncedAt ? formatExact(syncedAt) : 'Not updated yet'
  const text = status && status !== 'Idle' ? status : 'Refreshing'
  const known = progress != null && progress.total > 0
  return (
    <div className="refresh-cluster">
      <div className="freshness" ref={ref}>
        <button
          type="button"
          className="pip-btn"
          aria-expanded={open}
          aria-label={syncedAt ? `Last updated ${when}` : 'Not updated yet'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`pip ${freshness(syncedAt, now)}`} />
        </button>
        {open ? (
          <div className="freshness-pop" role="status">
            {when}
          </div>
        ) : null}
      </div>
      {refreshing ? (
        <div className="refresh-activity" aria-live="polite">
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
          ) : (
            <SyncArrows />
          )}
          <span className="refresh-text" title={text}>
            {text}
          </span>
        </div>
      ) : (
        <button type="button" className="ghost refresh-btn" onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
  )
}

function SyncArrows() {
  return (
    <svg className="refresh-spin" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 16h5v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
