import { execFileSync } from 'node:child_process'
import { budgetFromHeaders, GRAPHQL_SINGLE_FLOOR, type GraphqlBudget, graphqlView, type GraphqlView, rememberWindow } from '../shared/budget.ts'
import { Refused } from './errors.ts'
import { requestSignal } from './request-signal.ts'

export function loadGithubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    if (token) return token
  } catch {
    // Fall through to the message below.
  }
  throw new Error('No GitHub token. Set GITHUB_TOKEN, or run gh auth login.')
}

export class GraphqlPaused extends Refused {
  constructor(message: string) {
    super(message, 503)
  }
}

let graphqlWindows: GraphqlBudget[] = []

export function graphqlStatus(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()): GraphqlView {
  return graphqlView(graphqlWindows, now, floor)
}

export function assertGraphql(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()) {
  const view = graphqlStatus(floor, now)
  if (view.paused && view.message) throw new GraphqlPaused(view.message)
}

function rememberGraphql(response: Response): GraphqlBudget | null {
  const next = budgetFromHeaders(response.headers)
  if (!next) return null
  graphqlWindows = rememberWindow(graphqlWindows, next)
  return graphqlWindows.find((window) => window.resetAt === next.resetAt) ?? next
}

function markGraphqlSpent(seen: GraphqlBudget | null, resetAt = Date.now() + 60_000) {
  const when = seen && seen.resetAt > Date.now() ? seen.resetAt : resetAt
  graphqlWindows = rememberWindow(graphqlWindows, { limit: seen?.limit ?? 5000, remaining: 0, resetAt: when })
}

export async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>, partial = false): Promise<T> {
  assertGraphql()
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pr-dash',
    },
    body: JSON.stringify({ query, variables }),
    signal: requestSignal(60_000),
  })
  const seen = rememberGraphql(response)
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 280)}`)
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) {
    if (body.errors.some((error) => /rate limit/i.test(error.message))) {
      markGraphqlSpent(seen)
      throw new GraphqlPaused(graphqlStatus().message ?? body.errors.map((error) => error.message).join('; '))
    }
    if (!partial || !body.data) throw new Error(body.errors.map((error) => error.message).join('; '))
  }
  if (!body.data) throw new Error('GitHub query failed')
  return body.data
}

export async function rest(token: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pr-dash',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal(60_000),
  })
}

export async function eachBatch<T>(items: T[], size: number, concurrency: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size))
  let next = 0
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next]
      next += 1
      if (!batch) return
      await run(batch)
    }
  }
  const workers = Math.min(Math.max(concurrency, 1), batches.length)
  if (workers === 0) return
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

export function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as { message?: string }
    if (payload.message) return payload.message
  } catch {
    // Use the raw body below.
  }
  return text.slice(0, 280) || `GitHub ${status}`
}
