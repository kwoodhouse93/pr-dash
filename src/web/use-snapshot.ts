import { useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '../shared/sync.ts'
import { isListName, type ListName, type Snapshot } from '../shared/types.ts'
import { api, syncCancelled } from './api.ts'
import type { DashboardPage } from './prefs.ts'
import { clearActionError, toastError } from './toasts.tsx'

/** Skip another GitHub pull when the saved list is newer than this. The server refreshes the list more often. */
const REFRESH_MS = 2 * 60 * 1000
const SNAPSHOT_POLL_MS = 4_000

function snapshotKey(snap: Snapshot): string {
  return JSON.stringify([
    snap.mineSyncedAt,
    snap.reviewSyncedAt,
    snap.warning,
    snap.repos,
    snap.agents,
    snap.initiatives,
    snap.pullRequests,
    snap.reviewPullRequests,
    snap.departed,
  ])
}

export type RefreshProgress = { completed: number; total: number }

type RefreshOptions = { force?: boolean; focus?: ListName; full?: boolean; feedback?: 'if-ran' | 'always' }

/**
 * The saved lists and the refreshes that keep them current. The server holds the lists; this reads them when the
 * page opens, every few seconds after, and whenever the server says a refresh is under way, and asks for a
 * refresh when a list is opened or has gone stale. Each change made here supersedes a read that was already on its way.
 */
export function useSnapshot(page: DashboardPage) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [booting, setBooting] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [progress, setProgress] = useState<RefreshProgress | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const applyId = useRef(0)
  const watchedRef = useRef<string[]>([])
  const pageRef = useRef<DashboardPage>(page)
  pageRef.current = page
  const dataRef = useRef<Snapshot | null>(null)
  const painted = useRef('')
  const previousPage = useRef(page)
  const syncBusy = useRef(false)

  function adopt(snap: Snapshot): Snapshot {
    const reviewPullRequests = snap.reviewPullRequests ?? []
    watchedRef.current = snap.repos ?? []
    const next = { ...snap, reviewPullRequests }
    dataRef.current = next
    return next
  }

  function listedFocus(): ListName | undefined {
    const page = pageRef.current
    return isListName(page) ? page : undefined
  }

  function showIfChanged(snap: Snapshot, id: number) {
    if (id !== applyId.current) return
    const next = adopt(snap)
    const key = snapshotKey(next)
    if (key === painted.current) return
    painted.current = key
    setData(next)
  }

  async function refresh(options: RefreshOptions = {}) {
    const page = pageRef.current
    const focus = options.focus ?? (page === 'review' ? 'review' : 'mine')
    const listed = isListName(page)
    if (watchedRef.current.length === 0 && !options.force) return false
    const feedback = options.feedback ?? 'if-ran'
    if (!options.full && !listed && !options.force) return false
    const stamp = focus === 'review' ? dataRef.current?.reviewSyncedAt : dataRef.current?.mineSyncedAt
    const syncedMs = stamp ? Date.parse(stamp) : Number.NaN
    const recent = !options.force && !options.full && Number.isFinite(syncedMs) && Date.now() - syncedMs < REFRESH_MS
    if (recent) {
      if (feedback === 'always') await showFeedback(focus)
      return false
    }
    const id = ++applyId.current
    setRefreshing(true)
    clearActionError()
    setStatus('Starting refresh')
    setProgress(null)
    const poll = window.setInterval(() => {
      void api.snapshot(listedFocus()).then((snap) => {
        showIfChanged(snap, id)
      }).catch(() => undefined)
    }, 800)
    try {
      const snap = await api.refresh(focus, options.full === true, options.force === true || options.full === true)
      if (id === applyId.current) {
        const next = adopt(snap)
        painted.current = snapshotKey(next)
        setData(next)
      }
      if (id === applyId.current) {
        try {
          if (options.full) {
            await loadFeedback('mine')
            if (id === applyId.current) await loadFeedback('review')
          } else {
            await loadFeedback(focus)
          }
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'Could not load thread replies'
          if (!syncCancelled(caught) && id === applyId.current) toastError(message, { heading: 'Could not load thread replies' })
        }
      }
      return true
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Refresh failed'
      if (!syncCancelled(caught) && id === applyId.current) {
        toastError(message, { heading: 'Refresh failed', onRetry: () => void refresh({ ...options, force: true }) })
      }
      return false
    } finally {
      window.clearInterval(poll)
      if (id === applyId.current) setRefreshing(false)
    }
  }

  async function showFeedback(focus: ListName) {
    const id = ++applyId.current
    setRefreshing(true)
    setStatus('Reading thread replies')
    setProgress(null)
    try {
      await loadFeedback(focus)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not load thread replies'
      if (!syncCancelled(caught) && id === applyId.current) {
        toastError(message, { heading: 'Could not load thread replies', onRetry: () => void showFeedback(focus) })
      }
    } finally {
      if (id === applyId.current) setRefreshing(false)
    }
  }

  async function loadFeedback(which: ListName) {
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
      if (id === applyId.current) toastError(caught instanceof Error ? caught.message : 'Could not save that change', { heading: 'Could not save that change' })
      throw caught
    } finally {
      if (id === applyId.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancel = false
    const pull = () => {
      if (cancel || document.visibilityState !== 'visible') return
      const id = applyId.current
      void api.snapshot(listedFocus()).then((snap) => {
        if (!cancel) showIfChanged(snap, id)
      }).catch(() => undefined)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const id = applyId.current
      const page = pageRef.current
      void api.snapshot(listedFocus()).then((snap) => {
        if (cancel || id !== applyId.current) return
        showIfChanged(snap, id)
        if (isListName(page)) void refresh()
      }).catch(() => undefined)
    }
    ;(async () => {
      let snap: Snapshot | null = null
      try {
        snap = await api.snapshot(listedFocus())
        if (!cancel) {
          const next = adopt(snap)
          painted.current = snapshotKey(next)
          setData(next)
        }
      } catch (caught) {
        if (!cancel) toastError(caught instanceof Error ? caught.message : 'Could not load the saved list', { heading: 'Could not load the saved list' })
      } finally {
        if (!cancel) setBooting(false)
      }
      const page = pageRef.current
      if (!snap || snap.repos.length === 0) return
      if (isListName(page)) await refresh()
    })()
    const timer = window.setInterval(pull, SNAPSHOT_POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancel = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    if (!isListName(page)) return
    void refresh({ feedback: 'always' })
  }, [page])

  const syncWatch = page === 'settings' || refreshing || sync?.activity != null || (sync?.queue.length ?? 0) > 0
  useEffect(() => {
    if (!syncWatch) return
    let cancel = false
    const tick = () => {
      void api.status().then((next) => {
        if (cancel) return
        const busy = next.activity != null || next.queue.length > 0
        const finished = syncBusy.current && !busy
        syncBusy.current = busy
        setSync(next)
        if (refreshing || busy) {
          if (next.message !== 'Idle') setStatus(next.message)
          if (next.total > 0) setProgress({ completed: next.completed, total: next.total })
        }
        if (busy || finished) {
          void api.snapshot(listedFocus()).then((snap) => {
            if (!cancel) showIfChanged(snap, applyId.current)
          }).catch(() => undefined)
        }
        if (finished && !refreshing) {
          setStatus('Idle')
          setProgress(null)
        }
      }).catch(() => undefined)
    }
    tick()
    const timer = window.setInterval(tick, refreshing || sync?.activity != null ? 400 : 2000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [syncWatch, refreshing, sync?.activity != null])

  return {
    data,
    booting,
    refreshing,
    status,
    progress,
    sync,
    setSync,
    refresh,
    mutate,
    /** The list the page is on, or yours when it is on neither. */
    focus: (): ListName => (pageRef.current === 'review' ? 'review' : 'mine'),
    /** Puts a snapshot the server answered with on screen. */
    show: (snap: Snapshot) => setData(adopt(snap)),
    /** The same, and any read already on its way is dropped, since this is newer. */
    replace: (snap: Snapshot) => {
      ++applyId.current
      setData(adopt(snap))
    },
    /** Changes what is on screen without asking the server. */
    patch: (change: (current: Snapshot) => Snapshot) => setData((current) => (current ? change(current) : current)),
  }
}
