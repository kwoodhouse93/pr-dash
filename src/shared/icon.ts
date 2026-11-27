import { canSquashMerge } from './merge.ts'
import type { QueueSummary } from './queue.ts'
import type { Snapshot } from './types.ts'
import { needsAttention } from './view.ts'

/**
 * What the app's icon says, so a glance at the Dock or a browser tab answers whether to look.
 * `idle` is the icon as drawn, for before anything is known. The rest take the list's most urgent colour.
 */
export type IconState = {
  tone: 'idle' | 'clear' | 'needs' | 'broken'
  /** Pull requests waiting on the user. Shown as a number while the tone is `needs`. */
  count: number
  /** The merge queue is working. The bars move. */
  merging: boolean
}

export const ICON_FRAMES = 4

export function iconState(data: Snapshot | null, queue: Pick<QueueSummary, 'state' | 'held'> | null): IconState {
  const merging = queue?.state === 'active'
  if (!data) return { tone: 'idle', count: 0, merging }
  const watched = new Set(data.repos)
  const mine = data.pullRequests.filter((pr) => watched.has(pr.repo))
  const review = (data.reviewPullRequests ?? []).filter((pr) => watched.has(pr.repo))
  const count =
    mine.filter((pr) => needsAttention(pr, 'author') || canSquashMerge(pr)).length +
    review.filter((pr) => pr.reviewPending || needsAttention(pr, 'reviewer')).length
  const broken = (queue?.held ?? 0) > 0 || mine.some((pr) => !pr.isDraft && pr.ci === 'red')
  return { tone: broken ? 'broken' : count > 0 ? 'needs' : 'clear', count, merging }
}

const BARS = [
  { y: 7, width: 18 },
  { y: 14.4, width: 14 },
  { y: 21.8, width: 10 },
]
const AMBER = '#e0a15a'
const CREAM = '#f3f0e7'
const GREEN = '#8fbf73'
const RED = '#e36a58'
const COLORS: Record<IconState['tone'], string[]> = {
  idle: [AMBER, CREAM, GREEN],
  clear: [GREEN, GREEN, GREEN],
  needs: [AMBER, CREAM, GREEN],
  broken: [RED, CREAM, GREEN],
}
/** How long each bar is in each frame while the queue works: a ripple down the three. */
const RIPPLE = [
  [1, 0.8, 0.6],
  [0.8, 0.6, 0.8],
  [0.6, 0.8, 1],
  [0.8, 1, 0.8],
]

/**
 * The icon as an SVG. `dock` draws it the way macOS wants an app icon, with room around the tile.
 * `frame` picks the step of the ripple shown while merging.
 */
export function iconSvg(state: IconState, frame = 0, dock = false): string {
  const ripple = state.merging ? RIPPLE[frame % ICON_FRAMES]! : [1, 1, 1]
  const colors = COLORS[state.tone]
  const bars = BARS.map(
    (bar, index) => `<rect x="7" y="${bar.y}" width="${(bar.width * ripple[index]!).toFixed(2)}" height="3.2" rx="1.6" fill="${colors[index]}"/>`,
  ).join('')
  const badge =
    state.tone === 'needs' && state.count > 0
      ? `<circle cx="24.5" cy="7.5" r="6.2" fill="${AMBER}" stroke="#10110f" stroke-width="1.4"/><text x="24.5" y="10.2" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="${state.count > 9 ? 6.4 : 7.8}" font-weight="700" fill="#24180d">${state.count > 9 ? '9+' : state.count}</text>`
      : ''
  const star = state.tone === 'clear' && !state.merging ? '<path d="M24.5 17.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill="#c9f0ad"/>' : ''
  const tile = `<rect width="32" height="32" rx="${dock ? 7.22 : 8}" fill="#1c1b16"/>${bars}${star}${badge}`
  return dock
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(25.75)">${tile}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile}</svg>`
}

export function iconLabel(state: IconState): string {
  const tone = { idle: '', clear: 'Nothing waits on you', needs: `${state.count} waiting on you`, broken: 'Something is broken' }[state.tone]
  return [tone, state.merging ? 'merging' : ''].filter(Boolean).join(', ')
}
