import type { Context, Hono } from 'hono'
import { parseRepoName } from '../../shared/repos.ts'
import type { PullRequest } from '../../shared/types.ts'
import type { DashboardDb } from '../db.ts'
import { messageOf, pullGone, Refused } from '../errors.ts'

/** `loopbackOnly` is true when the dashboard serves this machine alone. `address` is where this server answers, such as `http://127.0.0.1:4317`. */
export type RouteOptions = { loopbackOnly: boolean; address: string }

/** What each group of routes is handed. */
export type Routes = (app: Hono, db: DashboardDb, options: RouteOptions) => void

/** The request's JSON, or nothing when it has none, so each route says what it is missing in its own words. */
export async function read<T extends object>(c: Context): Promise<Partial<T>> {
  const body: unknown = await c.req.json().catch(() => null)
  return body && typeof body === 'object' ? (body as Partial<T>) : {}
}

export function repoNamed(raw: unknown): string {
  try {
    return parseRepoName(typeof raw === 'string' ? raw : '')
  } catch (error) {
    throw new Refused(messageOf(error))
  }
}

/** A pull request on either list. */
export function listedPull(db: DashboardDb, key: string | undefined): PullRequest {
  const snap = db.snapshot()
  const pr = [...snap.pullRequests, ...snap.reviewPullRequests].find((item) => item.key === key)
  if (!pr) throw pullGone()
  return pr
}

export function required(key: string | undefined): string {
  if (!key) throw new Refused('A pull request is required.')
  return key
}
