/**
 * The flight of a task to where agents are listed: what was pressed folds into a small tied parcel, which
 * draws breath and flies along an arc to its place. The dashboard plays it in its own page.
 *
 * The desktop window's strip and sidebar are another page, built with a copy of this file, and the
 * dashboard's page lies over it. There both pages play the same flight at the same moment, each in its own
 * measure: the dashboard's parcel is cut off at the edge of its page, and the strip's shows from there on.
 * Nothing is laid over the dashboard, so it can be used all the while.
 * Nothing here needs React, and every colour is a theme token.
 */

import type { PressBox } from '../shared/agents.ts'

export type Box = PressBox

export type Flight = {
  /** Where the parcel is drawn. */
  layer: HTMLElement
  /** What was pressed. */
  from: Box
  /** What the task is, shown as it folds. */
  label: string
  /** Where it lands, asked as it takes off. With nowhere to land, the parcel fades where it is. */
  to: () => Box | null
  /** The time on the clock to start at, for two pages playing the one flight. Without it, now. */
  at?: number
  /** Called as the parcel leaves, with how long the flight takes, so the page can sound it. */
  onTakeoff?: (ms: number) => void
}

const SIZE = 18
const FOLD_MS = 300
const BREATH_MS = 220
const FLY_MS = 640
const STEPS = 24

function until(time: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, time - Date.now())))
}

function still(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function boxOf(element: Element): Box {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

/** The box of an element, or null for one that is not drawn. */
export function shownBox(element: Element | null): Box | null {
  if (!element) return null
  const box = boxOf(element)
  return box.width > 0 && box.height > 0 ? box : null
}

/**
 * Plays the flight. Resolves true once the parcel has landed, and false when nothing was played: with
 * reduced motion, or with nowhere to land.
 */
export async function flyParcel({ layer, from, label, to, at, onTakeoff }: Flight): Promise<boolean> {
  const parcel = document.createElement('div')
  if (still() || typeof parcel.animate !== 'function') return false
  if (at !== undefined) await until(at)
  const text = document.createElement('span')
  const tie = document.createElement('i')
  text.textContent = label
  Object.assign(parcel.style, {
    position: 'fixed',
    zIndex: '2147483000',
    left: `${from.x}px`,
    top: `${from.y}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    borderRadius: '7px',
    border: '1px solid var(--line-strong)',
    background: 'var(--bg-raised)',
    color: 'var(--text)',
    font: 'inherit',
    fontSize: '13px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    boxShadow: '0 4px 14px var(--shadow)',
    willChange: 'transform',
  })
  // The string round the parcel: one line across and one down.
  Object.assign(tie.style, {
    position: 'absolute',
    inset: '0',
    opacity: '0',
    background: 'linear-gradient(var(--amber), var(--amber)) center / 2px 100% no-repeat, linear-gradient(var(--amber), var(--amber)) center / 100% 2px no-repeat',
  })
  parcel.append(text, tie)
  layer.append(parcel)
  try {
    const cx = from.x + from.width / 2
    const cy = from.y + from.height / 2
    text.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FOLD_MS / 2, fill: 'forwards' })
    await parcel.animate([{}, { left: `${cx - SIZE / 2}px`, top: `${cy - SIZE / 2}px`, width: `${SIZE}px`, height: `${SIZE}px`, borderRadius: '5px' }], {
      duration: FOLD_MS,
      easing: 'cubic-bezier(0.5, 0, 0.2, 1)',
      fill: 'forwards',
    }).finished
    parcel.style.background = 'var(--amber-dim)'
    parcel.style.borderColor = 'var(--amber)'
    tie.animate([{ opacity: 0, transform: 'scale(0.3)' }, { opacity: 1, transform: 'none' }], { duration: 140, fill: 'forwards' })
    await parcel.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.78) rotate(-8deg)' }, { transform: 'scale(1.12)' }], { duration: BREATH_MS, easing: 'ease-in-out' }).finished

    // Two pages take off by the clock, not by when each one's folding happened to end.
    if (at !== undefined) await until(at + FOLD_MS + BREATH_MS + 40)
    const target = to()
    if (!target) {
      await parcel.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 160, fill: 'forwards' }).finished
      return false
    }
    const tx = target.x + target.width / 2 - cx
    const ty = target.y + target.height / 2 - cy
    // A swoop: the parcel drops back and away from where it is going, then sweeps round in a wide curve
    // and comes in from the side. The curve is to the upper side of the straight line. Every length is a
    // share of the distance, so two pages zoomed apart draw the same curve.
    const far = Math.hypot(tx, ty) || 1
    const side = { x: -ty / far, y: tx / far }
    const up = side.y > 0 ? { x: -side.x, y: -side.y } : side
    const sweep = far * 0.42
    const back = { x: -tx * 0.14 - up.x * sweep * 0.45, y: -ty * 0.14 - up.y * sweep * 0.45 }
    const over = { x: tx * 0.6 + up.x * sweep * 1.25, y: ty * 0.6 + up.y * sweep * 1.25 }
    const along = (t: number) => {
      const rest = 1 - t
      return { x: 3 * rest * rest * t * back.x + 3 * rest * t * t * over.x + t * t * t * tx, y: 3 * rest * rest * t * back.y + 3 * rest * t * t * over.y + t * t * t * ty }
    }
    const path = Array.from({ length: STEPS + 1 }, (_, step) => step / STEPS)
    const timing = { duration: FLY_MS, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'forwards' as const }
    const turn = tx < 0 ? -300 : 300
    for (let index = 1; index <= 3; index++) {
      const dot = document.createElement('i')
      Object.assign(dot.style, { position: 'fixed', zIndex: '2147482999', left: `${cx - 3}px`, top: `${cy - 3}px`, width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', opacity: '0', pointerEvents: 'none' })
      layer.append(dot)
      const frames = path.map((t) => {
        const point = along(t)
        return { transform: `translate(${point.x}px, ${point.y}px) scale(${1 - t * 0.6})`, opacity: t === 0 || t === 1 ? 0 : 0.5 - index * 0.12 }
      })
      void dot
        .animate(frames, { ...timing, delay: index * 38 })
        .finished.catch(() => undefined)
        .then(() => dot.remove())
    }
    onTakeoff?.(FLY_MS)
    await parcel.animate(
      path.map((t) => {
        const point = along(t)
        return { transform: `translate(${point.x}px, ${point.y}px) rotate(${t * turn}deg) scale(${1.12 - t * 0.55})`, opacity: t > 0.92 ? 0.6 : 1 }
      }),
      timing,
    ).finished
    return true
  } catch {
    // An animation that was cancelled, as when the page is torn down mid-flight.
    return false
  } finally {
    parcel.remove()
  }
}

/** Marks what caught the parcel for a moment, so a stylesheet can show the catch. */
export function markCaught(element: Element | null, ms = 520): void {
  if (!element) return
  element.classList.remove('caught')
  // Reading the box starts the mark again on a second catch.
  void element.getBoundingClientRect()
  element.classList.add('caught')
  window.setTimeout(() => element.classList.remove('caught'), ms)
}
