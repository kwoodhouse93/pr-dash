import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { reducedMotion } from './animations.ts'

export { reducedMotion }

/**
 * Lets a panel play its way out before it is taken away. `close` marks it as closing and calls `onClose`
 * once the exit has had time to run; with reduced motion it closes at once.
 */
export function useClosing(onClose: () => void, ms = 150): [closing: boolean, close: () => void] {
  const [closing, setClosing] = useState(false)
  const timer = useRef(0)
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const close = useCallback(() => {
    if (reducedMotion()) return latest.current()
    if (timer.current) return
    setClosing(true)
    timer.current = window.setTimeout(() => latest.current(), ms)
  }, [ms])
  return [closing, close]
}

const FOLD_MS = 200

/**
 * A section that grows open and draws shut instead of switching. Shut, it is taken out of the page; with
 * `keep` it stays there hidden, so what was typed in it is still there when it opens again.
 */
export function Fold({ open, keep = false, children }: { open: boolean; keep?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const was = useRef(open)
  const [closing, setClosing] = useState(false)
  // True in the render where `open` turned, before the effect below has marked the section as closing.
  const turned = was.current !== open
  useLayoutEffect(() => {
    if (was.current === open) return
    was.current = open
    const element = box.current
    if (!element || reducedMotion() || typeof element.animate !== 'function') return setClosing(false)
    const shut = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, overflow: 'hidden' }
    const full = { height: `${element.offsetHeight}px`, opacity: 1, overflow: 'hidden' }
    const run = element.animate(open ? [shut, full] : [full, shut], {
      duration: FOLD_MS,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: open ? 'none' : 'forwards',
    })
    setClosing(!open)
    if (open) return () => run.cancel()
    const timer = window.setTimeout(() => setClosing(false), FOLD_MS)
    return () => {
      window.clearTimeout(timer)
      run.cancel()
    }
  }, [open])
  const shown = open || closing || (turned && !reducedMotion())
  if (!shown && !keep) return null
  return (
    <div ref={box} className="fold-box" hidden={!shown}>
      {children}
    </div>
  )
}

/** A count that rolls to its next value instead of switching. */
export function Roll({ value, className }: { value: number | string; className?: string }) {
  const [shown, setShown] = useState({ from: value, to: value })
  useEffect(() => {
    if (shown.to === value) return
    if (reducedMotion()) return setShown({ from: value, to: value })
    setShown({ from: shown.to, to: value })
    const timer = window.setTimeout(() => setShown({ from: value, to: value }), 400)
    return () => window.clearTimeout(timer)
  }, [value])
  const rolling = shown.from !== shown.to
  return (
    <span className={`roll${rolling ? ' rolling' : ''}${className ? ` ${className}` : ''}`} aria-label={String(value)}>
      <span key={String(shown.from)} aria-hidden="true">
        {shown.from}
      </span>
      {rolling ? (
        <span key={String(shown.to)} aria-hidden="true">
          {shown.to}
        </span>
      ) : null}
    </span>
  )
}

/** In a list that was put in a new order, rows further than this from where they were are moved without a slide, so nothing flies across the page. */
const FAR = 480

/**
 * Slides table rows to their new place when rows above them come or go, so opening a stack or a merge
 * landing does not make the list jump. A row is known by its `data-flip` name.
 */
export function useSlidingRows(body: RefObject<HTMLElement | null>) {
  const places = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const root = body.current
    if (!root) return
    const next = new Map<string, number>()
    const rows = root.querySelectorAll<HTMLElement>('tr[data-flip]')
    for (const row of rows) next.set(row.dataset.flip!, row.offsetTop)
    const before = places.current
    places.current = next
    if (before.size === 0 || reducedMotion() || typeof root.animate !== 'function') return
    const view = root.closest('.scroll')
    const top = view?.scrollTop ?? 0
    const height = view?.clientHeight ?? window.innerHeight
    const bottom = top + height
    // When rows only came or went, the rest keep their order and move together, however far: closing a
    // long stack brings the rows under it up from off the page. Only a new order sends rows past each other.
    let sameOrder = true
    let last = -Infinity
    for (const row of rows) {
      const was = before.get(row.dataset.flip!)
      if (was === undefined) continue
      if (was < last) sameOrder = false
      last = was
    }
    for (const row of rows) {
      const now = next.get(row.dataset.flip!)!
      const was = before.get(row.dataset.flip!)
      if (was === undefined || was === now) continue
      if (!sameOrder && Math.abs(was - now) > FAR) continue
      if (now > bottom + FAR || now < top - FAR) continue
      // A row from further than a screen away starts a screen away, which looks the same and takes no longer.
      const from = Math.max(-height, Math.min(height, was - now))
      row.animate([{ transform: `translateY(${from}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
    }
  })
}

/**
 * Names the things whose signature changed since the last look, for a few seconds each. The first set of
 * signatures is where it starts from, so nothing is called changed when the page loads.
 * The number beside a name goes up on each change, so a second change can start its mark again.
 */
export function useChanged(signatures: Map<string, string>, ms = 5000): Map<string, number> {
  const seen = useRef<Map<string, string> | null>(null)
  const [changed, setChanged] = useState<Map<string, number>>(() => new Map())
  const count = useRef(0)
  useEffect(() => {
    const before = seen.current
    seen.current = signatures
    if (!before) return
    const fresh: string[] = []
    for (const [key, signature] of signatures) {
      const was = before.get(key)
      if (was !== undefined && was !== signature) fresh.push(key)
    }
    if (fresh.length === 0) return
    const stamp = ++count.current
    setChanged((current) => new Map([...current, ...fresh.map((key) => [key, stamp] as const)]))
    // The mark is left to run out even when the list changes again, so the timer is not cleared.
    window.setTimeout(() => {
      setChanged((current) => new Map([...current].filter(([, at]) => at !== stamp)))
    }, ms)
  }, [signatures, ms])
  return changed
}

/**
 * Keeps an item in a list for a moment after it has gone, when `keep` says its leaving is worth showing.
 * Returns the list with those items still in it, and the keys of the ones on their way out.
 * The item is held from the very render in which it went missing, so it is never gone for a frame first.
 */
export function useLingering<T extends { key: string }>(list: T[], keep: (item: T) => boolean, ms: number): { list: T[]; leaving: Set<string> } {
  const state = useRef({ list, ghosts: new Map<string, { item: T; until: number }>() })
  const [, redraw] = useState(0)
  const now = Date.now()
  const held = state.current
  if (held.list !== list) {
    const present = new Set(list.map((item) => item.key))
    for (const item of held.list) {
      if (!present.has(item.key) && !held.ghosts.has(item.key) && keep(item)) held.ghosts.set(item.key, { item, until: now + ms })
    }
    // One that has come back is no longer on its way out.
    for (const key of [...held.ghosts.keys()]) if (present.has(key)) held.ghosts.delete(key)
    held.list = list
  }
  for (const [key, ghost] of [...held.ghosts]) if (ghost.until <= now) held.ghosts.delete(key)
  const soonest = Math.min(...[...held.ghosts.values()].map((ghost) => ghost.until))
  useEffect(() => {
    if (!Number.isFinite(soonest)) return
    const timer = window.setTimeout(() => redraw((count) => count + 1), Math.max(0, soonest - Date.now()) + 20)
    return () => window.clearTimeout(timer)
  }, [soonest])
  if (held.ghosts.size === 0) return { list, leaving: EMPTY }
  const extra = [...held.ghosts.values()].map((ghost) => ghost.item)
  return { list: [...list, ...extra], leaving: new Set(extra.map((item) => item.key)) }
}

const EMPTY: Set<string> = new Set()
