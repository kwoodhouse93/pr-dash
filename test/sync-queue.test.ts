import { describe, expect, it } from 'vitest'
import { createSyncQueue, SyncCancelled } from '../src/server/sync-queue.ts'

function gate() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('sync queue', () => {
  it('runs a queued full sync after the current sync and ahead of a later list refresh', async () => {
    const queue = createSyncQueue()
    const order: string[] = []
    const first = gate()
    const running = queue.enqueue({
      kind: 'list',
      key: 'list-1',
      work: async () => {
        order.push('list')
        await first.promise
        return 'list'
      },
      summary: () => '',
    })
    await tick()
    const full = gate()
    expect(
      queue.enqueueUser({
        kind: 'full',
        work: async () => {
          order.push('full')
          await full.promise
          return 'done'
        },
        summary: () => 'Finished',
      }),
    ).toBe(true)
    const later = gate()
    const second = queue.enqueue({
      kind: 'list',
      key: 'list-2',
      work: async () => {
        order.push('later')
        await later.promise
        return 'later'
      },
      summary: () => '',
    })
    expect(queue.view().activity?.kind).toBe('list')
    expect(queue.view().upcoming.map((job) => job.kind)).toEqual(['full', 'list'])

    first.release()
    await running
    await tick()
    expect(order).toEqual(['list', 'full'])
    expect(queue.view().activity?.kind).toBe('full')

    full.release()
    await tick()
    later.release()
    await second
    expect(order).toEqual(['list', 'full', 'later'])
    expect(queue.view().history.map((entry) => entry.outcome)).toEqual(['done'])
  })

  it('keeps one queued sync of each kind and records a second only while one is running', async () => {
    const queue = createSyncQueue()
    const running = gate()
    expect(
      queue.enqueueUser({
        kind: 'full',
        work: () => running.promise.then(() => 'done'),
        summary: () => 'Finished',
      }),
    ).toBe(true)
    await tick()
    expect(queue.view().activity?.kind).toBe('full')
    expect(
      queue.enqueueUser({
        kind: 'full',
        work: async () => 'again',
        summary: () => 'Finished',
      }),
    ).toBe(true)
    expect(
      queue.enqueueUser({
        kind: 'full',
        work: async () => 'third',
        summary: () => 'Finished',
      }),
    ).toBe(false)
    expect(
      queue.enqueueUser({
        kind: 'rules',
        work: async () => 'rules',
        summary: () => 'Finished',
      }),
    ).toBe(true)
    expect(queue.view().upcoming.map((job) => job.kind)).toEqual(['full', 'rules'])
    running.release()
    await tick()
  })

  it('removes a queued sync and aborts the one that is running', async () => {
    const queue = createSyncQueue()
    const order: string[] = []
    const blocker = gate()
    const running = queue.enqueue({
      kind: 'list',
      key: 'current',
      work: (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          blocker.promise.then(() => resolve('stay'))
        }),
      summary: () => '',
    })
    await tick()
    expect(
      queue.enqueueUser({
        kind: 'rules',
        work: async () => {
          order.push('rules')
          return 'rules'
        },
        summary: () => 'Finished',
      }),
    ).toBe(true)
    const waitingId = queue.view().upcoming[0]?.id
    expect(waitingId).toBeTruthy()
    expect(queue.cancel(waitingId!)).toBe(true)
    expect(queue.view().upcoming).toEqual([])
    expect(queue.view().history[0]).toMatchObject({
      kind: 'rules',
      outcome: 'cancelled',
      message: 'Cancelled before it started',
      startedAt: null,
    })

    const activeId = queue.view().activity?.id
    expect(queue.cancel(activeId!)).toBe(true)
    await expect(running).rejects.toBeInstanceOf(SyncCancelled)
    expect(order).toEqual([])
    expect(queue.view().activity).toBeNull()
  })

  it('records a failed ruleset sync and keeps the newest entries', async () => {
    const queue = createSyncQueue({ historyLimit: 2 })
    expect(
      queue.enqueueUser({
        kind: 'rules',
        work: async () => {
          throw new Error('GitHub 502')
        },
        summary: () => 'Finished',
      }),
    ).toBe(true)
    await tick()
    expect(queue.view().history[0]).toMatchObject({ kind: 'rules', outcome: 'failed', message: 'GitHub 502' })

    queue.enqueueUser({
      kind: 'full',
      work: async () => 'rate limit',
      summary: (value) => value,
    })
    await tick()
    queue.enqueueUser({
      kind: 'rules',
      work: async () => 'ok',
      summary: () => 'Finished',
    })
    await tick()
    expect(queue.view().history.map((entry) => entry.kind)).toEqual(['rules', 'full'])
    expect(queue.view().history[1]?.message).toBe('rate limit')
  })

  it('does not log an ordinary list refresh', async () => {
    const queue = createSyncQueue()
    await queue.enqueue({
      kind: 'list',
      key: 'mine:tab',
      work: async () => 'snap',
      summary: () => '',
    })
    expect(queue.view().history).toEqual([])
  })

  it('runs a pull refresh ahead of a waiting threads job', async () => {
    const queue = createSyncQueue()
    const order: string[] = []
    const first = gate()
    const running = queue.enqueue({
      kind: 'list',
      key: 'list-1',
      work: async () => {
        order.push('list')
        await first.promise
        return 'list'
      },
      summary: () => '',
    })
    await tick()
    const threads = queue.enqueue({
      kind: 'threads',
      key: 'threads:mine',
      work: async () => {
        order.push('threads')
        return 'threads'
      },
      summary: () => '',
    })
    const pull = queue.enqueueInteractive({
      kind: 'pull',
      key: 'pull:owner/repo#1',
      work: async () => {
        order.push('pull')
        return 'pull'
      },
      summary: () => '',
    })
    expect(queue.view().upcoming.map((job) => job.kind)).toEqual(['pull', 'threads'])

    first.release()
    await running
    await pull
    await threads
    expect(order).toEqual(['list', 'pull', 'threads'])
  })

  it('preempts a running threads job so a pull refresh can start, then resumes threads', async () => {
    const queue = createSyncQueue()
    const order: string[] = []
    const blocker = gate()
    let threadsAttempts = 0
    const threads = queue.enqueue({
      kind: 'threads',
      key: 'threads:mine',
      work: (signal) => {
        threadsAttempts += 1
        order.push(`threads-${threadsAttempts}`)
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          blocker.promise.then(() => {
            signal.removeEventListener('abort', onAbort)
            resolve('threads')
          })
        })
      },
      summary: () => '',
    })
    await tick()
    expect(queue.view().activity?.kind).toBe('threads')

    const pull = queue.enqueueInteractive({
      kind: 'pull',
      key: 'pull:owner/repo#1',
      work: async () => {
        order.push('pull')
        return 'pull'
      },
      summary: () => '',
    })
    await pull
    expect(order).toEqual(['threads-1', 'pull', 'threads-2'])
    expect(queue.view().activity?.kind).toBe('threads')

    blocker.release()
    await threads
    expect(order).toEqual(['threads-1', 'pull', 'threads-2'])
    expect(threadsAttempts).toBe(2)
  })

  it('promotes a waiting list refresh to interactive instead of duplicating it', async () => {
    const queue = createSyncQueue()
    const order: string[] = []
    const first = gate()
    const running = queue.enqueueInteractive({
      kind: 'pull',
      key: 'pull:owner/repo#1',
      work: async () => {
        order.push('pull')
        await first.promise
        return 'pull'
      },
      summary: () => '',
    })
    await tick()
    const background = queue.enqueue({
      kind: 'list',
      key: 'mine:tab',
      work: async () => {
        order.push('list')
        return 'list'
      },
      summary: () => '',
    })
    const interactive = queue.enqueueInteractive({
      kind: 'list',
      key: 'mine:tab',
      work: async () => {
        order.push('duplicate')
        return 'duplicate'
      },
      summary: () => '',
    })
    expect(interactive).toBe(background)
    expect(queue.view().upcoming.map((job) => job.kind)).toEqual(['list'])

    first.release()
    await running
    await background
    expect(order).toEqual(['pull', 'list'])
  })
})
