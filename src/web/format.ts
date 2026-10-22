const REPO_PIPS = ['#e0a15a', '#7eb0d4', '#8fbf73', '#d7a0c4', '#9aa7e8', '#e38b6d', '#7ec8c3', '#e2b34a']

export function repoColors(repos: string[]): Map<string, string> {
  const unique = [...new Set(repos)].sort()
  return new Map(unique.map((repo, index) => [repo, REPO_PIPS[index % REPO_PIPS.length]!]))
}

export function formatCount(value: number): string {
  const abs = Math.abs(value)
  if (abs < 1000) return String(abs)
  const scaled = abs / 1000
  const text = scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '')
  return `${text}k`
}

export function formatWhen(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const delta = now - time
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta >= 0 && delta < minute) return 'just now'
  if (delta >= 0 && delta < hour) return `${Math.floor(delta / minute)}m`
  if (delta >= 0 && delta < day) return `${Math.floor(delta / hour)}h`
  if (delta >= 0 && delta < 7 * day) return `${Math.floor(delta / day)}d`
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatExact(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Graphite PR page for a `owner/repo` key and pull request number. */
export function graphitePrUrl(repo: string, number: number): string {
  return `https://app.graphite.dev/github/pr/${repo}/${number}`
}
