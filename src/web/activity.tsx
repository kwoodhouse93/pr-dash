import { useMemo, useState } from 'react'
import { formatSpan, summarizeActivity, type Activity, type ActivityRange, type Bucket, type Counts } from '../shared/activity.ts'

const RANGES: { id: ActivityRange; label: string; phrase: string }[] = [
  { id: '6w', label: '6 weeks', phrase: 'last 6 weeks' },
  { id: '3m', label: '3 months', phrase: 'last 3 months' },
  { id: 'year', label: 'Year', phrase: 'last year' },
]

function day(time: number, year = false): string {
  return new Date(time).toLocaleDateString('en-GB', year ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
}

function against(now: number, was: number): string {
  if (now === was) return 'Level with this time last week'
  return `${Math.abs(now - was)} ${now > was ? 'up' : 'down'} on this time last week`
}

/** The axis top and the lines under it: round numbers, three or four of them. */
function scale(peak: number): number[] {
  const step = peak <= 15 ? 5 : peak <= 30 ? 10 : Math.ceil(peak / 3 / 10) * 10
  const top = Math.max(1, Math.ceil(peak / step)) * step
  return Array.from({ length: top / step + 1 }, (_, index) => index * step)
}

/** Which columns carry a date under them: each Monday on the short range, otherwise the first of each month. */
function labelled(buckets: Bucket[], range: ActivityRange): Set<number> {
  const starts = new Set<number>()
  let month = -1
  for (const bucket of buckets) {
    const date = new Date(bucket.start)
    if (range === '6w') {
      if (date.getDay() === 1) starts.add(bucket.start)
    } else if (date.getMonth() !== month && (bucket.span === 'week' || date.getDay() === 1)) {
      // The first column only names its month when it starts one, so a label is never a part month.
      if (month !== -1 || date.getDate() <= 7) starts.add(bucket.start)
      month = date.getMonth()
    }
  }
  return starts
}

function Chart({ buckets, range, now }: { buckets: Bucket[]; range: ActivityRange; now: number }) {
  const lines = scale(Math.max(...buckets.map((bucket) => bucket.merged + bucket.reviewed)))
  const top = lines.at(-1)!
  const labels = labelled(buckets, range)
  const current = buckets.at(-1)?.start
  return (
    <div className="act-chart" data-range={range}>
      <div className="act-plot">
        {lines.map((value) => (
          <span key={value} className="act-line" style={{ bottom: `${(value / top) * 100}%` }}>
            <span>{value}</span>
          </span>
        ))}
        <div className="act-cols">
          {buckets.map((bucket, index) => {
            const when = bucket.span === 'week' ? `Week of ${day(bucket.start)}` : new Date(bucket.start).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
            const live = bucket.start === current && bucket.start <= now
            return (
              <div
                key={bucket.start}
                className={`act-col${live ? ' now' : ''}${index > buckets.length * 0.6 ? ' late' : ''}`}
                tabIndex={0}
                aria-label={`${when}: ${bucket.merged} merged, ${bucket.reviewed} reviewed`}
              >
                {bucket.reviewed > 0 ? <i className="reviewed" style={{ height: `${(bucket.reviewed / top) * 100}%` }} /> : null}
                {bucket.merged > 0 ? <i className="merged" style={{ height: `${(bucket.merged / top) * 100}%` }} /> : null}
                <span className="act-tip" aria-hidden="true">
                  <b>{when}</b>
                  <span>
                    <i className="merged" />
                    {bucket.merged} merged
                  </span>
                  <span>
                    <i className="reviewed" />
                    {bucket.reviewed} reviewed
                  </span>
                </span>
                {labels.has(bucket.start) ? (
                  <span className="act-date">{range === '6w' ? day(bucket.start) : new Date(bucket.start).toLocaleDateString('en-GB', { month: 'short' })}</span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Tile({ label, kind, value, detail }: { label: string; kind?: keyof Counts; value: string; detail: string }) {
  return (
    <div className="act-tile">
      <p className="act-tile-label">
        {kind ? <i className={kind} aria-hidden="true" /> : null}
        {label}
      </p>
      <p className="act-tile-value">{value}</p>
      <p className="act-tile-detail">{detail}</p>
    </div>
  )
}

/** Your merges and reviews over time. `activity` is null until it has loaded. */
export function ActivityPage({ activity, now }: { activity: Activity | null; now: number }) {
  const [range, setRange] = useState<ActivityRange>('6w')
  // The day decides every figure here, so the clock only matters when it changes the hour.
  const hour = Math.floor(now / 3_600_000)
  const summary = useMemo(() => (activity ? summarizeActivity(activity, now, range) : null), [activity, hour, range])
  if (!summary) return <section className="act-page" aria-busy="true" />
  if (summary.since == null) {
    return (
      <section className="act-page">
        <div className="empty">
          <h2>Nothing on record yet</h2>
          <p>Your merges and the reviews you submit are counted here from now on.</p>
        </div>
      </section>
    )
  }
  const phrase = RANGES.find((item) => item.id === range)!.phrase
  const most = Math.max(1, ...summary.repos.map((repo) => repo.merged + repo.reviewed))
  return (
    <section className="act-page">
      <div className="act-head">
        <div>
          <h2>This week</h2>
          <p className="act-since">
            {summary.total.merged} merged and {summary.total.reviewed} reviewed since {day(summary.since, true)}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((item) => (
            <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => setRange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="act-tiles">
        <Tile label="Merged" kind="merged" value={String(summary.week.merged)} detail={against(summary.week.merged, summary.lastWeek.merged)} />
        <Tile label="Reviewed" kind="reviewed" value={String(summary.week.reviewed)} detail={against(summary.week.reviewed, summary.lastWeek.reviewed)} />
        <Tile
          label="Ready to merged"
          value={summary.readyToMerged == null ? 'None yet' : formatSpan(summary.readyToMerged)}
          detail={summary.readyToMerged == null ? `No merges timed in the ${phrase}` : `Median, ${phrase}`}
        />
        <Tile
          label="Review turnaround"
          value={summary.readyToReviewed == null ? 'None yet' : formatSpan(summary.readyToReviewed)}
          detail={summary.readyToReviewed == null ? `No reviews timed in the ${phrase}` : `Median from ready to your first review, ${phrase}`}
        />
      </div>

      <div className="panel act-panel">
        <div className="act-panel-head">
          <h2>{range === 'year' ? 'Each week' : 'Each day'}</h2>
          <p className="act-legend">
            <span>
              <i className="merged" aria-hidden="true" />
              Merged
            </span>
            <span>
              <i className="reviewed" aria-hidden="true" />
              Reviewed
            </span>
          </p>
        </div>
        <Chart buckets={summary.buckets} range={range} now={now} />
      </div>

      <div className="act-pair">
        <div className="panel act-panel">
          <div className="act-panel-head">
            <h2>Records</h2>
          </div>
          <ul className="act-records">
            {summary.records.map((record) => (
              <li key={record.id}>
                <span>
                  {record.label}
                  <em>{record.url ? <a href={record.url}>{record.detail}</a> : record.detail}</em>
                </span>
                <b>{record.value}</b>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel act-panel">
          <div className="act-panel-head">
            <h2>By repository</h2>
            <p className="act-note">{phrase}</p>
          </div>
          {summary.repos.length === 0 ? <p className="act-note">Nothing in the {phrase}.</p> : null}
          <ul className="act-repos">
            {summary.repos.map((repo) => (
              <li key={repo.repo} title={`${repo.repo}: ${repo.merged} merged, ${repo.reviewed} reviewed`}>
                <span className="act-repo-name">{repo.repoName}</span>
                <span className="act-repo-bar" aria-hidden="true">
                  {repo.merged > 0 ? <i className="merged" style={{ width: `${(repo.merged / most) * 100}%` }} /> : null}
                  {repo.reviewed > 0 ? <i className="reviewed" style={{ width: `${(repo.reviewed / most) * 100}%` }} /> : null}
                </span>
                <span className="act-repo-count">{repo.merged + repo.reviewed}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
