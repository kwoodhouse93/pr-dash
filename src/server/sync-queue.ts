import { SYNC_CANCELLED, type SyncHistoryEntry, type SyncJob, type SyncKind, type SyncOutcome, type UserSyncKind } from '../shared/sync.ts'
import { Refused } from './errors.ts'

/** Lower runs first. Interactive (row refresh) preempts user/background; user preempts background. */
export type SyncPriority = 'interactive' | 'user' | 'background'

export class SyncCancelled extends Refused {
  constructor() {
    super('Sync cancelled', 409, SYNC_CANCELLED)
  }
}

const PRIORITY_RANK: Record<SyncPriority, number> = {
  interactive: 0,
  user: 1,
  background: 2,
}

type Job = {
  id: string
  kind: SyncKind
  user: boolean
  priority: SyncPriority
  key: string | null
  controller: AbortController
  startedAt: string | null
  preempted: boolean
  work: (signal: AbortSignal) => Promise<unknown>
  summary: (value: unknown) => string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  promise: Promise<unknown>
}

type Enqueue<T> = {
  kind: SyncKind
  key: string | null
  work: (signal: AbortSignal) => Promise<T>
  summary: (value: T) => string
}

type EnqueueUser<T> = {
  kind: UserSyncKind
  work: (signal: AbortSignal) => Promise<T>
  summary: (value: T) => string
}

export function createSyncQueue(options?: {
  historyLimit?: number
  now?: () => string
  onStart?: (job: SyncJob) => void
  onIdle?: () => void
}) {
  const historyLimit = options?.historyLimit ?? 20
  const now = options?.now ?? (() => new Date().toISOString())
  let seq = 0
  let pumping = false
  let active: Job | null = null
  const waiting: Job[] = []
  const history: SyncHistoryEntry[] = []

  function record(job: Job, outcome: SyncOutcome, message: string) {
    if (!job.user || (job.kind !== 'full' && job.kind !== 'rules')) return
    history.unshift({
      id: job.id,
      kind: job.kind,
      outcome,
      message,
      startedAt: job.startedAt,
      finishedAt: now(),
    })
    if (history.length > historyLimit) history.length = historyLimit
  }

  function orderedWaiting(): Job[] {
    return [
      ...waiting.filter((job) => job.priority === 'interactive'),
      ...waiting.filter((job) => job.priority === 'user'),
      ...waiting.filter((job) => job.priority === 'background'),
    ]
  }

  function preemptLower(priority: SyncPriority) {
    if (!active || PRIORITY_RANK[active.priority] <= PRIORITY_RANK[priority]) return
    active.preempted = true
    active.controller.abort()
  }

  function requeuePreempted(job: Job) {
    job.preempted = false
    job.controller = new AbortController()
    job.startedAt = null
    waiting.push(job)
  }

  function push<T>(spec: Enqueue<T> & { user: boolean; priority: SyncPriority }): Promise<T> {
    const controller = new AbortController()
    let resolve: (value: T) => void = () => undefined
    let reject: (error: unknown) => void = () => undefined
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    const job: Job = {
      id: `sync-${++seq}`,
      kind: spec.kind,
      user: spec.user,
      priority: spec.priority,
      key: spec.key,
      controller,
      startedAt: null,
      preempted: false,
      work: spec.work as Job['work'],
      summary: spec.summary as Job['summary'],
      resolve: resolve as Job['resolve'],
      reject,
      promise,
    }
    waiting.push(job)
    promise.catch(() => undefined)
    // Only interactive work (row refresh / forced tab refresh) preempts; Settings syncs still wait out the active job.
    if (spec.priority === 'interactive') preemptLower(spec.priority)
    kick()
    return promise
  }

  function kick() {
    if (pumping) return
    pumping = true
    void pump().finally(() => {
      pumping = false
      if (waiting.length > 0) kick()
      else options?.onIdle?.()
    })
  }

  async function pump() {
    while (waiting.length > 0) {
      const next = orderedWaiting()[0]
      if (!next) break
      waiting.splice(waiting.indexOf(next), 1)
      if (next.controller.signal.aborted) {
        if (next.preempted) {
          requeuePreempted(next)
          continue
        }
        record(next, 'cancelled', 'Cancelled before it started')
        next.reject(new SyncCancelled())
        continue
      }
      active = next
      next.startedAt = now()
      options?.onStart?.({ id: next.id, kind: next.kind })
      try {
        const value = await next.work(next.controller.signal)
        if (next.controller.signal.aborted && !next.preempted) {
          record(next, 'cancelled', 'Cancelled')
          next.reject(new SyncCancelled())
        } else {
          // Completed work wins over a preempt abort that the job ignored.
          next.preempted = false
          record(next, 'done', next.summary(value).trim() || 'Finished')
          next.resolve(value)
        }
      } catch (error) {
        if (next.preempted && (next.controller.signal.aborted || error instanceof SyncCancelled)) {
          requeuePreempted(next)
        } else if (next.controller.signal.aborted || error instanceof SyncCancelled) {
          record(next, 'cancelled', 'Cancelled')
          next.reject(error instanceof SyncCancelled ? error : new SyncCancelled())
        } else {
          const message = error instanceof Error && error.message ? error.message : 'Sync failed'
          record(next, 'failed', message)
          next.reject(error)
        }
      } finally {
        if (active === next) active = null
      }
    }
  }

  function findByKey(key: string): Job | undefined {
    if (active?.key === key) return active
    return waiting.find((job) => job.key === key)
  }

  function promote(job: Job, priority: SyncPriority) {
    if (PRIORITY_RANK[job.priority] <= PRIORITY_RANK[priority]) return
    job.priority = priority
    preemptLower(priority)
  }

  return {
    enqueue<T>(spec: Enqueue<T>): Promise<T> {
      if (spec.key) {
        const existing = findByKey(spec.key)
        if (existing) return existing.promise as Promise<T>
      }
      return push({ ...spec, user: false, priority: 'background' })
    },
    enqueueInteractive<T>(spec: Enqueue<T>): Promise<T> {
      if (spec.key) {
        const existing = findByKey(spec.key)
        if (existing) {
          promote(existing, 'interactive')
          return existing.promise as Promise<T>
        }
      }
      return push({ ...spec, user: false, priority: 'interactive' })
    },
    enqueueUser<T>(spec: EnqueueUser<T>): boolean {
      if (waiting.some((job) => job.user && job.kind === spec.kind)) return false
      void push({ ...spec, user: true, priority: 'user', key: null })
      return true
    },
    cancel(id: string): boolean {
      const index = waiting.findIndex((job) => job.id === id)
      if (index >= 0) {
        const job = waiting.splice(index, 1)[0]
        if (!job) return false
        job.preempted = false
        job.controller.abort()
        record(job, 'cancelled', 'Cancelled before it started')
        job.reject(new SyncCancelled())
        if (!pumping && waiting.length === 0 && active == null) options?.onIdle?.()
        return true
      }
      if (active?.id === id) {
        active.preempted = false
        active.controller.abort()
        return true
      }
      return false
    },
    view(): { activity: SyncJob | null; upcoming: SyncJob[]; history: SyncHistoryEntry[] } {
      return {
        activity: active ? { id: active.id, kind: active.kind } : null,
        upcoming: orderedWaiting().map((job) => ({ id: job.id, kind: job.kind })),
        history: history.slice(),
      }
    },
  }
}
