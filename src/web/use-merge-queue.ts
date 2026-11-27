import { useEffect, useRef, useState } from 'react'
import type { QueueSnapshot } from '../shared/queue.ts'
import { api } from './api.ts'

/** The merge queue, read every second while the page is in view. `onFinished` runs when an entry that was queued is done or cancelled. */
export function useMergeQueue(onFinished: () => void) {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const seenQueue = useRef(new Set<string>())
  const finished = useRef(onFinished)
  finished.current = onFinished

  useEffect(() => {
    let cancel = false
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void api.mergeQueue().then((next) => {
        if (cancel) return
        const done = new Set(
          next.history.filter((entry) => entry.status === 'done' || entry.status === 'cancelled').map((entry) => entry.id),
        )
        const landed = [...seenQueue.current].some((id) => done.has(id))
        seenQueue.current = new Set(next.entries.map((entry) => entry.id))
        setQueue(next)
        if (landed) finished.current()
      }).catch(() => undefined)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])
  return [queue, setQueue] as const
}
