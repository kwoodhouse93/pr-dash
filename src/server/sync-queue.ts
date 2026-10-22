export type SyncKind = 'full' | 'rules' | 'list' | 'pull' | 'threads'
export type UserSyncKind = 'full' | 'rules'
export type SyncOutcome = 'done' | 'failed' | 'cancelled'

export type SyncQueueItem = {
  id: string
  kind: SyncKind
}

export type SyncHistoryEntry = {
  id: string
  kind: UserSyncKind
  outcome: SyncOutcome
  message: string
  startedAt: string | null
  finishedAt: string
}

export class SyncCancelled extends Error {
  constructor() {
    super('Sync cancelled')
    this.name = 'SyncCancelled'
  }
}

type Job = {
  id: string
  kind: SyncKind
  user: boolean
  key: string | null
  controller: AbortController
  startedAt: string | null
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
  onStart?: (job: SyncQueueItem) => void
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
    return [...waiting.filter((job) => job.user), ...waiting.filter((job) => !job.user)]
  }

  function push<T>(spec: Enqueue<T> & { user: boolean }): Promise<T> {
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
      key: spec.key,
      controller,
      startedAt: null,
      work: spec.work as Job['work'],
      summary: spec.summary as Job['summary'],
      resolve: resolve as Job['resolve'],
      reject,
      promise,
    }
    waiting.push(job)
    promise.catch(() => undefined)
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
        record(next, 'cancelled', 'Cancelled before it started')
        next.reject(new SyncCancelled())
        continue
      }
      active = next
      next.startedAt = now()
      options?.onStart?.({ id: next.id, kind: next.kind })
      try {
        const value = await next.work(next.controller.signal)
        if (next.controller.signal.aborted) {
          record(next, 'cancelled', 'Cancelled')
          next.reject(new SyncCancelled())
        } else {
          record(next, 'done', next.summary(value).trim() || 'Finished')
          next.resolve(value)
        }
      } catch (error) {
        if (next.controller.signal.aborted || error instanceof SyncCancelled) {
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

  return {
    enqueue<T>(spec: Enqueue<T>): Promise<T> {
      if (spec.key) {
        if (active?.key === spec.key) return active.promise as Promise<T>
        const pending = waiting.find((job) => job.key === spec.key)
        if (pending) return pending.promise as Promise<T>
      }
      return push({ ...spec, user: false })
    },
    enqueueUser<T>(spec: EnqueueUser<T>): boolean {
      if (waiting.some((job) => job.user && job.kind === spec.kind)) return false
      void push({ ...spec, user: true, key: null })
      return true
    },
    cancel(id: string): boolean {
      const index = waiting.findIndex((job) => job.id === id)
      if (index >= 0) {
        const job = waiting.splice(index, 1)[0]
        if (!job) return false
        job.controller.abort()
        record(job, 'cancelled', 'Cancelled before it started')
        job.reject(new SyncCancelled())
        if (!pumping && waiting.length === 0 && active == null) options?.onIdle?.()
        return true
      }
      if (active?.id === id) {
        active.controller.abort()
        return true
      }
      return false
    },
    view(): { activity: SyncQueueItem | null; upcoming: SyncQueueItem[]; history: SyncHistoryEntry[] } {
      return {
        activity: active ? { id: active.id, kind: active.kind } : null,
        upcoming: orderedWaiting().map((job) => ({ id: job.id, kind: job.kind })),
        history: history.slice(),
      }
    },
  }
}
