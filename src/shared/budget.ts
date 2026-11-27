/** Bulk list refreshes stop below this, leaving a reserve for one-pull-request reloads. */
export const GRAPHQL_PAUSE_BELOW = 200

/** A single pull request costs about one point, so it waits only when the budget is empty. */
export const GRAPHQL_SINGLE_FLOOR = 1

export type GraphqlBudget = {
  limit: number
  remaining: number
  resetAt: number
}

export type GraphqlWindowView = {
  limit: number
  remaining: number
  resetAt: string
}

export type GraphqlView = {
  paused: boolean
  limit: number | null
  remaining: number | null
  resetAt: string | null
  message: string | null
  windows: GraphqlWindowView[]
}

/** Keep every open window. A repeated reading of one window cannot raise its remaining count. */
export function rememberWindow(windows: GraphqlBudget[], next: GraphqlBudget, now = Date.now()): GraphqlBudget[] {
  const open = windows.filter((window) => window.resetAt > now)
  if (next.resetAt <= now) return open
  const current = open.find((window) => window.resetAt === next.resetAt)
  const chosen = current && current.remaining < next.remaining ? current : next
  return [...open.filter((window) => window.resetAt !== next.resetAt), chosen].sort((a, b) => a.resetAt - b.resetAt)
}

export function budgetFromHeaders(headers: { get(name: string): string | null }): GraphqlBudget | null {
  const resource = headers.get('x-ratelimit-resource')
  if (resource && resource !== 'graphql') return null
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const reset = Number(headers.get('x-ratelimit-reset'))
  const limit = Number(headers.get('x-ratelimit-limit'))
  if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return null
  return {
    limit: Number.isFinite(limit) ? limit : 5000,
    remaining,
    resetAt: reset * 1000,
  }
}

export function pauseMessage(resetAt: string | null, remaining: number | null): string {
  const when = resetAt ? new Date(resetAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'the window resets'
  const left = remaining == null ? '' : ` (${remaining} points left)`
  return `GitHub GraphQL refreshes are paused until ${when}${left}.`
}

export function graphqlView(windows: GraphqlBudget[], now: number, floor = GRAPHQL_PAUSE_BELOW): GraphqlView {
  const open = windows.filter((window) => window.resetAt > now).sort((a, b) => a.resetAt - b.resetAt)
  const shown = open.map((window) => ({
    limit: window.limit,
    remaining: window.remaining,
    resetAt: new Date(window.resetAt).toISOString(),
  }))
  const budget = open.reduce<GraphqlBudget | null>((lowest, window) => {
    if (!lowest || window.remaining < lowest.remaining) return window
    return lowest
  }, null)
  if (!budget) return { paused: false, limit: null, remaining: null, resetAt: null, message: null, windows: shown }
  const resetAt = new Date(budget.resetAt).toISOString()
  const paused = budget.remaining < floor
  return {
    paused,
    limit: budget.limit,
    remaining: budget.remaining,
    resetAt,
    message: paused ? pauseMessage(resetAt, budget.remaining) : null,
    windows: shown,
  }
}
