import type { DashboardDb } from './db.ts'
import { refreshCursorSessions } from './cursor.ts'
import { fetchAuthoredPullRequests, fetchReviewPullRequests, loadGithubToken } from './github.ts'
import { enrichLinearProjects } from './linear.ts'
import type { PullRequest, Snapshot } from '../shared/types.ts'

export const syncStatus = { running: false, message: 'Idle' }

export type RefreshFocus = 'mine' | 'review'

const mergedKeys = new Set<string>()
let focus: RefreshFocus = 'mine'

export function markMerged(key: string) {
  mergedKeys.add(key)
}

export function omitMerged(pullRequests: PullRequest[]): PullRequest[] {
  for (const key of mergedKeys) {
    if (!pullRequests.some((pr) => pr.key === key)) mergedKeys.delete(key)
  }
  if (mergedKeys.size === 0) return pullRequests
  return pullRequests.filter((pr) => !mergedKeys.has(pr.key))
}

let inflight: Promise<Snapshot> | null = null

export function refreshSnapshot(db: DashboardDb, next: RefreshFocus = 'mine'): Promise<Snapshot> {
  focus = next
  if (inflight) return inflight
  inflight = run(db).finally(() => {
    inflight = null
    syncStatus.running = false
    syncStatus.message = 'Idle'
  })
  return inflight
}

function joinWarning(left: string | null, right: string | null): string | null {
  if (left && right) return `${left}; ${right}`
  return left ?? right
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Refresh failed'
}

async function run(db: DashboardDb): Promise<Snapshot> {
  syncStatus.running = true
  syncStatus.message = 'Starting refresh'
  const token = loadGithubToken()
  const warnings: string[] = []
  const done = new Set<RefreshFocus>()
  let focusError: string | null = null
  let saved = false
  while (done.size < 2) {
    const next: RefreshFocus = !done.has(focus) ? focus : focus === 'review' ? 'mine' : 'review'
    if (done.has(next)) break
    try {
      const warning = next === 'mine' ? await refreshMine(db, token, warnings) : await refreshReview(db, token, warnings)
      if (warning) warnings.push(warning)
      saved = true
    } catch (error) {
      const message = messageOf(error)
      if (next === focus) focusError = message
      else warnings.push(message)
    }
    done.add(next)
  }
  if (!saved && (focusError || warnings.length > 0)) throw new Error(focusError ?? warnings.join('; '))
  if (warnings.length > 0 || focusError) {
    const snap = db.snapshot()
    db.saveSnapshot({
      viewer: snap.viewer ?? '',
      syncedAt: snap.syncedAt ?? new Date().toISOString(),
      pullRequests: snap.pullRequests,
      reviewPullRequests: snap.reviewPullRequests,
      linearConfigured: snap.linearConfigured,
      warning: joinWarning(warnings.join('; ') || null, focusError),
    })
  }
  if (focusError) throw new Error(focusError)
  syncStatus.message = 'Checking Cursor'
  await refreshCursorSessions(db.cursorSessions(), (prKey, session) => db.saveCursorSession(prKey, session))
  return db.snapshot()
}

async function refreshMine(db: DashboardDb, token: string, warnings: string[]): Promise<string | null> {
  const fetched = await fetchAuthoredPullRequests(token, (message) => {
    syncStatus.message = message
  })
  const warning = await withLinear(fetched.pullRequests, fetched.warning)
  const current = db.snapshot()
  db.saveSnapshot({
    viewer: fetched.viewer,
    syncedAt: new Date().toISOString(),
    pullRequests: db.queue.overlay(omitMerged(fetched.pullRequests)),
    reviewPullRequests: current.reviewPullRequests,
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning: joinWarning(warnings.filter(Boolean).join('; ') || null, warning),
  })
  return warning
}

async function refreshReview(db: DashboardDb, token: string, warnings: string[]): Promise<string | null> {
  const fetched = await fetchReviewPullRequests(token, (message) => {
    syncStatus.message = message
  })
  const warning = await withLinear(fetched.pullRequests, fetched.warning)
  const current = db.snapshot()
  db.saveSnapshot({
    viewer: fetched.viewer || current.viewer || '',
    syncedAt: new Date().toISOString(),
    pullRequests: current.pullRequests,
    reviewPullRequests: fetched.pullRequests,
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning: joinWarning(warnings.filter(Boolean).join('; ') || null, warning),
  })
  return warning
}

async function withLinear(pullRequests: PullRequest[], warning: string | null): Promise<string | null> {
  const linearKey = process.env.LINEAR_API_KEY
  if (!linearKey) return warning
  syncStatus.message = 'Reading Linear projects'
  try {
    await enrichLinearProjects(pullRequests, linearKey)
    return warning
  } catch (error) {
    return joinWarning(warning, messageOf(error))
  }
}
