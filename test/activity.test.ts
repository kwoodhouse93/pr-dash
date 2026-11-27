import { describe, expect, it } from 'vitest'
import { formatSpan, personalBests, summarizeActivity, type Activity, type ActivityEvent } from '../src/shared/activity.ts'

let next = 1
function event(at: Date, over: Partial<ActivityEvent> = {}): ActivityEvent {
  const number = over.number ?? next++
  return {
    key: `acme/app#${number}`,
    repo: 'acme/app',
    repoName: 'app',
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    at: at.toISOString(),
    readyAt: null,
    ...over,
  }
}
/** Local time on a day in November 2026; the 25th is a Wednesday. */
const on = (day: number, hour = 10, minute = 0) => new Date(2026, 10, day, hour, minute)
const now = on(25, 15).getTime()
const many = (count: number, at: Date) => Array.from({ length: count }, () => event(at))

describe('activity summary', () => {
  it('counts this week against the same point of last week', () => {
    const activity: Activity = {
      merged: [event(on(16)), event(on(18, 9)), event(on(18, 17)), event(on(20)), event(on(23)), event(on(25))],
      reviewed: [],
    }
    const summary = summarizeActivity(activity, now, '6w')
    expect(summary.week.merged).toBe(2)
    // Monday and Wednesday morning of last week; Wednesday evening and Friday had not happened by this point.
    expect(summary.lastWeek.merged).toBe(2)
    expect(summary.total.merged).toBe(6)
    expect(summary.since).toBe(on(16).getTime())
  })

  it('counts a pull request reviewed twice in a day once, and again on another day', () => {
    const activity: Activity = { merged: [], reviewed: [event(on(24, 9), { number: 7 }), event(on(24, 16), { number: 7 }), event(on(25, 9), { number: 7 })] }
    const summary = summarizeActivity(activity, now, '6w')
    const byDay = new Map(summary.buckets.map((bucket) => [bucket.start, bucket.reviewed]))
    expect(byDay.get(on(24, 0).getTime())).toBe(1)
    expect(byDay.get(on(25, 0).getTime())).toBe(1)
    expect(summary.week.reviewed).toBe(1)
    expect(summary.total.reviewed).toBe(1)
  })

  it('gives a day to each column, ending today, and a week to each on the year', () => {
    const activity: Activity = { merged: [event(on(25))], reviewed: [] }
    const days = summarizeActivity(activity, now, '6w').buckets
    expect(days).toHaveLength(42)
    expect(days.at(-1)).toMatchObject({ start: on(25, 0).getTime(), span: 'day', merged: 1 })
    const weeks = summarizeActivity(activity, now, 'year').buckets
    expect(weeks).toHaveLength(53)
    expect(weeks.at(-1)).toMatchObject({ start: on(23, 0).getTime(), span: 'week', merged: 1 })
  })

  it('takes the median from ready to merged, and to the first review of each pull request', () => {
    const ready = on(24, 8)
    const activity: Activity = {
      merged: [
        event(on(24, 9), { readyAt: ready.toISOString() }),
        event(on(24, 11), { readyAt: ready.toISOString() }),
        event(on(24, 18), { readyAt: ready.toISOString() }),
        event(on(24, 19)),
      ],
      reviewed: [event(on(24, 8, 30), { number: 90, readyAt: ready.toISOString() }), event(on(25, 8), { number: 90, readyAt: ready.toISOString() })],
    }
    const summary = summarizeActivity(activity, now, '6w')
    expect(summary.readyToMerged).toBe(3 * 3_600_000)
    expect(summary.readyToReviewed).toBe(30 * 60_000)
    expect(summary.records.find((record) => record.id === 'fastest-review')).toMatchObject({ value: '30m', detail: 'app #90, ready to reviewed' })
    expect(summary.records.find((record) => record.id === 'fastest-merge')?.value).toBe('1h')
  })

  it('keeps the records and splits the range by repository', () => {
    const activity: Activity = {
      merged: [...many(3, on(10)), ...many(2, on(24)), event(on(24), { repo: 'acme/api', repoName: 'api', key: 'acme/api#1' })],
      reviewed: many(4, on(24, 14)),
    }
    const summary = summarizeActivity(activity, now, '6w')
    expect(summary.records.find((record) => record.id === 'merged-day')).toMatchObject({ value: '3 pull requests', detail: 'Tue, 10 Nov 2026' })
    expect(summary.records.find((record) => record.id === 'reviewed-week')).toMatchObject({ value: '4 pull requests', detail: 'Week of Mon, 23 Nov 2026' })
    expect(summary.records.find((record) => record.id === 'busiest-hour')?.value).toBe('10am to 11am')
    expect(summary.repos).toEqual([
      { repo: 'acme/app', repoName: 'app', merged: 5, reviewed: 4 },
      { repo: 'acme/api', repoName: 'api', merged: 1, reviewed: 0 },
    ])
  })

  it('formats a span in its two largest units', () => {
    expect(formatSpan(20_000)).toBe('1m')
    expect(formatSpan(4 * 60_000)).toBe('4m')
    expect(formatSpan(5 * 3_600_000 + 10 * 60_000)).toBe('5h 10m')
    expect(formatSpan(51 * 3_600_000)).toBe('2d 3h')
  })
})

describe('personal bests', () => {
  const past = many(3, on(10))

  it('reports the merge that takes today past the best day, once', () => {
    const three: Activity = { merged: [...past, ...many(3, on(25))], reviewed: [] }
    const four: Activity = { merged: [...three.merged, event(on(25, 14))], reviewed: [] }
    const five: Activity = { merged: [...four.merged, event(on(25, 14, 30))], reviewed: [] }
    expect(personalBests({ merged: [...past, ...many(2, on(25))], reviewed: [] }, three, now)).toEqual([])
    expect(personalBests(three, four, now)).toEqual([
      { kind: 'merged', span: 'day', count: 4, was: 3 },
      { kind: 'merged', span: 'week', count: 4, was: 3 },
    ])
    expect(personalBests(four, five, now)).toEqual([])
  })

  it('does not call the first days on record a best', () => {
    const before: Activity = { merged: [], reviewed: [event(on(24))] }
    const after: Activity = { merged: [], reviewed: [...before.reviewed, ...many(2, on(25))] }
    expect(personalBests(before, after, now)).toEqual([])
  })

  it('reports a week that passes the best week without a best day in it', () => {
    const weeks = [...many(2, on(9)), ...many(2, on(10)), ...many(2, on(11))]
    const before: Activity = { merged: [], reviewed: [...weeks, ...many(2, on(23)), ...many(2, on(24)), ...many(2, on(25))] }
    const after: Activity = { merged: [], reviewed: [...before.reviewed, event(on(25, 14))] }
    expect(personalBests(before, after, now)).toEqual([
      { kind: 'reviewed', span: 'day', count: 3, was: 2 },
      { kind: 'reviewed', span: 'week', count: 7, was: 6 },
    ])
  })
})
