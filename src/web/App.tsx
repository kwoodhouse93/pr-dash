import { useEffect, useMemo, useRef, useState } from 'react'
import { rowMarks } from '../shared/queue.ts'
import type { QueueSnapshot } from '../shared/queue.ts'
import { DEFAULT_FILTERS, type Filters, type Snapshot, type SortKey } from '../shared/types.ts'
import { cursorLinks } from '../shared/cursor.ts'
import { buildOutline, outlineEmpty } from '../shared/view.ts'
import { api } from './api.ts'
import { ManageInitiatives } from './editors.tsx'
import { formatExact, repoColors } from './format.ts'
import { ClickCard, MenuProvider } from './menus.tsx'
import { loadPreferences, savePreferences } from './prefs.ts'
import { MergeQueuePage } from './queue.tsx'
import { PrTable } from './table.tsx'

export function App() {
  const [prefs, setPrefs] = useState(loadPreferences)
  const [data, setData] = useState<Snapshot | null>(null)
  const [booting, setBooting] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [page, setPage] = useState<'list' | 'queue'>('list')
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const applyId = useRef(0)
  const mergedKeys = useRef(new Set<string>())
  const seenQueue = useRef(new Set<string>())

  function adopt(snap: Snapshot): Snapshot {
    if (mergedKeys.current.size === 0) return snap
    return { ...snap, pullRequests: snap.pullRequests.filter((pr) => !mergedKeys.current.has(pr.key)) }
  }

  useEffect(() => savePreferences(prefs), [prefs])

  async function refresh() {
    const id = ++applyId.current
    setRefreshing(true)
    setError(null)
    try {
      const snap = await api.refresh()
      if (id === applyId.current) setData(adopt(snap))
    } catch (caught) {
      if (id === applyId.current) setError(caught instanceof Error ? caught.message : 'Refresh failed')
    } finally {
      if (id === applyId.current) setRefreshing(false)
    }
  }

  async function mutate(work: () => Promise<Snapshot>) {
    const id = ++applyId.current
    setError(null)
    try {
      const snap = await work()
      if (id === applyId.current) setData(adopt(snap))
    } catch (caught) {
      if (id === applyId.current) setError(caught instanceof Error ? caught.message : 'Could not save that change')
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
        if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not load the saved snapshot')
      } finally {
        if (!cancel) setBooting(false)
      }
      await refresh()
    })()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60_000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])

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
        if (finished) void refresh()
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
    if (!refreshing) return
    const timer = window.setInterval(() => {
      void api.status().then((next) => setStatus(next.message)).catch(() => undefined)
    }, 400)
    return () => window.clearInterval(timer)
  }, [refreshing])

  const prs = data?.pullRequests ?? []
  const initiatives = data?.initiatives ?? []
  const prByKey = useMemo(() => new Map(prs.map((pr) => [pr.key, pr])), [prs])
  const outline = useMemo(
    () => buildOutline(prs, initiatives, prefs.filters, prefs.sort),
    [prs, initiatives, prefs],
  )
  const repos = useMemo(() => [...new Set(prs.map((pr) => pr.repo))].sort(), [prs])
  const colors = useMemo(() => repoColors(repos), [repos])
  const visible = !outlineEmpty(outline)
  const filtersOn = JSON.stringify(prefs.filters) !== JSON.stringify(DEFAULT_FILTERS)

  function patchFilters(patch: Partial<Filters>) {
    setPrefs((current) => ({ ...current, filters: { ...current.filters, ...patch } }))
  }

  async function changeQueue(work: () => Promise<QueueSnapshot>, refreshAfter = false) {
    setError(null)
    try {
      setQueue(await work())
      if (refreshAfter) void refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the merge queue')
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
      <div className="app">
        <header className="top">
          <div className="top-row">
            <div className="brand">
              <h1>{page === 'queue' ? 'Merge queue' : 'Pull requests'}</h1>
              <nav className="nav">
                <button type="button" className="text-btn" aria-pressed={page === 'list'} onClick={() => setPage('list')}>
                  Pull requests
                </button>
                <button type="button" className="text-btn" aria-pressed={page === 'queue'} onClick={() => setPage('queue')}>
                  Merge queue
                  {queue && queue.entries.length > 0 ? <span className="nav-count">{queue.entries.length}</span> : null}
                </button>
              </nav>
              <p className="meta">
                {data?.viewer ? <strong>{data.viewer}</strong> : 'Your open changes'}
                {prs.length ? ` · ${prs.length} open` : ''}
                {data?.syncedAt ? ` · updated ${formatExact(data.syncedAt)}` : ''}
                {refreshing ? ` · ${status}` : ''}
              </p>
            </div>
            <button type="button" className="primary" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
          <div className="filters" hidden={page === 'queue'}>
            <input
              className="search"
              value={prefs.filters.query}
              onChange={(event) => patchFilters({ query: event.target.value })}
              placeholder="Title, repo, number, issue"
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
              Awaiting you
            </button>
            <button
              type="button"
              className="ghost"
              aria-pressed={prefs.filters.hideDrafts}
              onClick={() => patchFilters({ hideDrafts: !prefs.filters.hideDrafts })}
            >
              Hide drafts
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
          </div>
        </header>
        {error ? <div className="banner error">{error}</div> : null}
        {notice ? <div className="banner">{notice}</div> : null}
        {data?.warning ? <div className="banner">{data.warning}</div> : null}
        {data && !data.linearConfigured && prs.some((pr) => pr.linearIssues.length > 0) ? (
          <div className="banner">
            Set LINEAR_API_KEY to load Linear status, assignee, and project. Issue titles still come from GitHub, and initiatives do not need Linear.
          </div>
        ) : null}
        <div className="scroll">
          {page === 'queue' ? (
            <MergeQueuePage
              queue={queue}
              onCancel={(id) => changeQueue(() => api.cancelMerge(id), true)}
              onMove={(id, direction) => changeQueue(() => api.moveMerge(id, direction))}
            />
          ) : null}
          {page === 'list' && booting && prs.length === 0 ? <div className="empty">Loading saved pull requests…</div> : null}
          {page === 'list' && !booting && prs.length === 0 && refreshing ? <div className="empty">{status}</div> : null}
          {page === 'list' && !booting && prs.length === 0 && !refreshing ? (
            <div className="empty">
              <h2>No open pull requests</h2>
              <p>This view is pull requests you authored. Refresh again after the next one is open.</p>
            </div>
          ) : null}
          {page === 'list' && prs.length > 0 && !visible ? (
            <div className="empty">
              <h2>Nothing matches</h2>
              <p>Clear a filter to see the rest of the outline.</p>
            </div>
          ) : null}
          {page === 'list' && prs.length > 0 && visible ? (
            <PrTable
              outline={outline}
              sort={prefs.sort}
              initiatives={initiatives}
              prByKey={prByKey}
              repoColor={colors}
              expanded={new Set(prefs.expanded)}
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
              linearConfigured={Boolean(data?.linearConfigured)}
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
              onRerun={async (keys, mode) => {
                const result = await api.rerun(keys, mode)
                const text = result.errors.length
                  ? `Reran ${result.reran}. ${result.errors[0]}`
                  : `Reran ${result.reran} workflow${result.reran === 1 ? '' : 's'}.`
                setNotice(text)
                void refresh()
                return text
              }}
              onResolveConflictWithCursor={async (key) => {
                const snap = await api.resolveConflictWithCursor(key)
                ++applyId.current
                setData(adopt(snap))
                const session = snap.pullRequests.find((item) => item.key === key)?.cursorSession
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
