/** One merge of yours, or one review you submitted. */
export type ActivityEvent = {
  key: string
  repo: string
  repoName: string
  number: number
  title: string
  url: string
  at: string
  /** When review could start. Null where it was not recorded. */
  readyAt: string | null
}

/** Everything the dashboard has on record, oldest first. A pull request reviewed more than once has an event for each review. */
export type Activity = { merged: ActivityEvent[]; reviewed: ActivityEvent[] }

export type ActivityKind = 'merged' | 'reviewed'
export type ActivityRange = '6w' | '3m' | 'year'
export type Counts = Record<ActivityKind, number>

export type Bucket = Counts & {
  /** Local midnight the bucket starts at. */
  start: number
  /** A day, or a week from Monday. */
  span: 'day' | 'week'
}

export type RecordRow = {
  id: string
  label: string
  value: string
  /** What the record was set on: a date, a week or a pull request. */
  detail: string
  url?: string
}

export type ActivitySummary = {
  /** This week so far, and the same days of last week. */
  week: Counts
  lastWeek: Counts
  total: Counts
  /** The earliest event on record, or null with none. */
  since: number | null
  buckets: Bucket[]
  /** Median time from ready for review to merged, over the range. Null with nothing to measure. */
  readyToMerged: number | null
  /** Median time from ready for review to your first review, over the range. */
  readyToReviewed: number | null
  repos: (Counts & { repo: string; repoName: string })[]
  records: RecordRow[]
}

const DAY = 24 * 60 * 60 * 1000
const RANGE_DAYS: Record<ActivityRange, number> = { '6w': 42, '3m': 91, year: 371 }

function startOfDay(time: number): number {
  return new Date(time).setHours(0, 0, 0, 0)
}

/** Local midnight on the Monday of the week `time` falls in. */
function startOfWeek(time: number): number {
  const day = new Date(startOfDay(time))
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

/** Local midnight `days` calendar days from `start`, so a clock change does not move it. */
function addDays(start: number, days: number): number {
  const day = new Date(start)
  day.setDate(day.getDate() + days)
  return day.getTime()
}

/**
 * How many pull requests fall in each period. A merge counts once; a pull request reviewed twice in one period counts once in it.
 */
function tally(events: ActivityEvent[], period: (time: number) => number): Map<number, number> {
  const seen = new Map<number, Set<string>>()
  for (const event of events) {
    const time = Date.parse(event.at)
    if (Number.isNaN(time)) continue
    const start = period(time)
    seen.set(start, (seen.get(start) ?? new Set()).add(event.key))
  }
  return new Map([...seen].map(([start, keys]) => [start, keys.size]))
}

function countBetween(events: ActivityEvent[], from: number, to: number): number {
  const keys = new Set<string>()
  for (const event of events) {
    const time = Date.parse(event.at)
    if (time >= from && time < to) keys.add(event.key)
  }
  return keys.size
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Each pull request's first event, which is what a turnaround is measured to. */
function firsts(events: ActivityEvent[]): ActivityEvent[] {
  const first = new Map<string, ActivityEvent>()
  for (const event of events) {
    const known = first.get(event.key)
    if (!known || event.at < known.at) first.set(event.key, event)
  }
  return [...first.values()]
}

/** Time from ready for review to the event, where both are known and in that order. */
function waited(event: ActivityEvent): number | null {
  if (!event.readyAt) return null
  const span = Date.parse(event.at) - Date.parse(event.readyAt)
  return Number.isFinite(span) && span > 0 ? span : null
}

function waits(events: ActivityEvent[], from: number): number[] {
  return events
    .filter((event) => Date.parse(event.at) >= from)
    .map(waited)
    .filter((span): span is number => span != null)
}

/** "4m", "5h 10m", "2d 3h": the two largest units, which is as exact as a turnaround is worth. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

function formatDay(time: number): string {
  return new Date(time).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function formatHour(hour: number): string {
  const name = (value: number) => `${value % 12 === 0 ? 12 : value % 12}${value % 24 < 12 ? 'am' : 'pm'}`
  return `${name(hour)} to ${name(hour + 1)}`
}

function best(counts: Map<number, number>, before = Infinity): { start: number; count: number } | null {
  let top: { start: number; count: number } | null = null
  // The earliest holds a tie, so a record is only ever beaten, not matched.
  for (const [start, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (start < before && (!top || count > top.count)) top = { start, count }
  }
  return top
}

function records(activity: Activity): RecordRow[] {
  const rows: RecordRow[] = []
  const pulls = (count: number) => `${count} pull request${count === 1 ? '' : 's'}`
  for (const kind of ['merged', 'reviewed'] as const) {
    const day = best(tally(activity[kind], startOfDay))
    if (day) rows.push({ id: `${kind}-day`, label: `Most ${kind} in a day`, value: pulls(day.count), detail: formatDay(day.start) })
  }
  for (const kind of ['merged', 'reviewed'] as const) {
    const week = best(tally(activity[kind], startOfWeek))
    if (week) rows.push({ id: `${kind}-week`, label: `Most ${kind} in a week`, value: pulls(week.count), detail: `Week of ${formatDay(week.start)}` })
  }
  const quickest = (events: ActivityEvent[]) =>
    events.reduce<{ event: ActivityEvent; span: number } | null>((top, event) => {
      const span = waited(event)
      return span != null && (!top || span < top.span) ? { event, span } : top
    }, null)
  const review = quickest(firsts(activity.reviewed))
  if (review) {
    rows.push({
      id: 'fastest-review',
      label: 'Fastest review',
      value: formatSpan(review.span),
      detail: `${review.event.repoName} #${review.event.number}, ready to reviewed`,
      url: review.event.url,
    })
  }
  const merge = quickest(activity.merged)
  if (merge) {
    rows.push({
      id: 'fastest-merge',
      label: 'Fastest merge',
      value: formatSpan(merge.span),
      detail: `${merge.event.repoName} #${merge.event.number}, ready to merged`,
      url: merge.event.url,
    })
  }
  const hours = new Map<number, number>()
  for (const event of [...activity.merged, ...activity.reviewed]) {
    const time = Date.parse(event.at)
    if (!Number.isNaN(time)) hours.set(new Date(time).getHours(), (hours.get(new Date(time).getHours()) ?? 0) + 1)
  }
  const busiest = best(hours)
  if (busiest) rows.push({ id: 'busiest-hour', label: 'Busiest hour', value: formatHour(busiest.start), detail: 'merges and reviews' })
  return rows
}

export function summarizeActivity(activity: Activity, now: number, range: ActivityRange): ActivitySummary {
  const today = startOfDay(now)
  const monday = startOfWeek(now)
  const kinds = ['merged', 'reviewed'] as const
  const counts = (pick: (events: ActivityEvent[]) => number): Counts => ({ merged: pick(activity.merged), reviewed: pick(activity.reviewed) })

  const from = range === 'year' ? addDays(monday, -52 * 7) : addDays(today, 1 - RANGE_DAYS[range])
  const span = range === 'year' ? 'week' : 'day'
  const period = span === 'week' ? startOfWeek : startOfDay
  const perPeriod = { merged: tally(activity.merged, period), reviewed: tally(activity.reviewed, period) }
  const buckets: Bucket[] = []
  for (let start = from; start <= now; start = addDays(start, span === 'week' ? 7 : 1)) {
    buckets.push({ start, span, merged: perPeriod.merged.get(start) ?? 0, reviewed: perPeriod.reviewed.get(start) ?? 0 })
  }

  const repos = new Map<string, Counts & { repo: string; repoName: string; keys: Record<ActivityKind, Set<string>> }>()
  for (const kind of kinds) {
    for (const event of activity[kind]) {
      if (!(Date.parse(event.at) >= from)) continue
      const row = repos.get(event.repo) ?? {
        repo: event.repo,
        repoName: event.repoName,
        merged: 0,
        reviewed: 0,
        keys: { merged: new Set(), reviewed: new Set() },
      }
      row.keys[kind].add(event.key)
      row[kind] = row.keys[kind].size
      repos.set(event.repo, row)
    }
  }

  const times = [...activity.merged, ...activity.reviewed].map((event) => Date.parse(event.at)).filter((time) => !Number.isNaN(time))
  return {
    week: counts((events) => countBetween(events, monday, Infinity)),
    // Up to the same time of day, so a Wednesday morning is not held against all of last Wednesday.
    lastWeek: counts((events) => countBetween(events, addDays(monday, -7), now - 7 * DAY)),
    total: counts((events) => new Set(events.map((event) => event.key)).size),
    since: times.length > 0 ? Math.min(...times) : null,
    buckets,
    readyToMerged: median(waits(activity.merged, from)),
    readyToReviewed: median(waits(firsts(activity.reviewed), from)),
    repos: [...repos.values()]
      .map(({ keys: _keys, ...row }) => row)
      .sort((a, b) => b.merged + b.reviewed - (a.merged + a.reviewed) || a.repoName.localeCompare(b.repoName)),
    records: records(activity),
  }
}

export type PersonalBest = { kind: ActivityKind; span: 'day' | 'week'; count: number; was: number }

/** A first day or two on record would make every merge a record, so a best has to beat something. */
const WORTH_BEATING = 2

function standing(events: ActivityEvent[], now: number, span: 'day' | 'week'): { count: number; was: number } {
  const period = span === 'day' ? startOfDay : startOfWeek
  const counts = tally(events, period)
  const current = period(now)
  return { count: counts.get(current) ?? 0, was: best(counts, current)?.count ?? 0 }
}

/**
 * Records that `next` holds and `before` did not: today, or this week, has passed the best earlier one.
 * Each is reported once, as it is passed, and not again as the same day or week runs further ahead.
 */
export function personalBests(before: Activity, next: Activity, now: number): PersonalBest[] {
  const bests: PersonalBest[] = []
  for (const kind of ['merged', 'reviewed'] as const) {
    for (const span of ['day', 'week'] as const) {
      const after = standing(next[kind], now, span)
      const earlier = standing(before[kind], now, span)
      if (after.was >= WORTH_BEATING && after.count > after.was && earlier.count <= after.was) bests.push({ kind, span, ...after })
    }
  }
  return bests
}
