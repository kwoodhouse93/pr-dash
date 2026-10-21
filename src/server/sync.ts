import { carryThreadFeedback } from '../shared/feedback.ts'
import { applyThreadDetails, mapPullRequest } from '../shared/map.ts'
import { refreshSteps, stepIndex, type RefreshStep } from '../shared/progress.ts'
import type { PullRequest, Snapshot } from '../shared/types.ts'
import { GRAPHQL_PAUSE_BELOW } from '../shared/budget.ts'
import { rulesFresh } from '../shared/rules.ts'
import { refreshCursorSessions } from './cursor.ts'
import type { DashboardDb } from './db.ts'
import {
  GraphqlPaused,
  assertGraphql,
  fetchAuthoredPullRequests,
  fetchOnePull,
  fetchRepoRules,
  fetchReviewPullRequests,
  fetchThreadDetails,
  forgetViewerContext,
  graphqlStatus,
  loadGithubToken,
  viewerFor,
  type RepoRules,
} from './github.ts'
import { enrichLinearProjects } from './linear.ts'

export const syncStatus = { running: false, message: 'Idle', completed: 0, total: 0 }

let steps: RefreshStep[] = []
let stepAt = 0

function beginSteps(full: boolean) {
  steps = refreshSteps(full, Boolean(process.env.LINEAR_API_KEY))
  stepAt = 0
  syncStatus.completed = 0
  syncStatus.total = steps.length
  syncStatus.message = 'Starting refresh'
}

function note(message: string) {
  syncStatus.message = message
  const next = stepIndex(steps, stepAt, message)
  if (next === stepAt) return
  stepAt = next
  syncStatus.completed = next
}

export type RefreshFocus = 'mine' | 'review'

const mergedKeys = new Set<string>()
let tail: Promise<unknown> = Promise.resolve()
let current: { key: string; promise: Promise<Snapshot> } | null = null

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

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function refreshSnapshot(db: DashboardDb, next: RefreshFocus = 'mine', options?: { full?: boolean }): Promise<Snapshot> {
  const full = options?.full === true
  const key = `${next}:${full ? 'full' : 'tab'}`
  if (current?.key === key) return current.promise
  const promise = exclusive(() => run(db, next, full)).finally(() => {
    if (current?.promise === promise) current = null
  })
  current = { key, promise }
  return promise
}

export function loadThreadFeedback(db: DashboardDb, next: RefreshFocus): Promise<{ snapshot: Snapshot; pending: number; paused: boolean }> {
  return exclusive(() => readFeedback(db, next))
}

export function refreshPull(db: DashboardDb, key: string): Promise<Snapshot> {
  return exclusive(() => readOne(db, key))
}

function joinWarning(left: string | null, right: string | null): string | null {
  if (left && right) return `${left}; ${right}`
  return left ?? right
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Refresh failed'
}

function pauseNow(): string | null {
  return graphqlStatus(GRAPHQL_PAUSE_BELOW).message
}

async function rulesFor(
  db: DashboardDb,
  token: string,
  repos: string[],
  force: boolean,
  onProgress: (message: string) => void,
): Promise<Map<string, RepoRules>> {
  const now = Date.now()
  const cached = new Map(db.ruleCache().map((item) => [item.repo, item]))
  const needed = repos.filter((repo) => force || !rulesFresh(cached.get(repo)?.fetchedAt, now))
  const fetched = new Map<string, RepoRules>()
  if (needed.length > 0) {
    try {
      const loaded = await fetchRepoRules(token, needed, onProgress)
      const fetchedAt = new Date().toISOString()
      for (const [repo, rules] of loaded) {
        fetched.set(repo, rules)
        db.saveRules(repo, rules, fetchedAt)
      }
    } catch (error) {
      if (!needed.every((repo) => cached.has(repo))) throw error
    }
  }
  const rules = new Map<string, RepoRules>()
  for (const repo of repos) {
    const fresh = fetched.get(repo)
    const old = cached.get(repo)
    rules.set(
      repo,
      fresh ??
        (old
          ? { checks: old.checks, requiredApprovals: old.requiredApprovals, dismissStale: old.dismissStale }
          : { checks: [], requiredApprovals: 0, dismissStale: false }),
    )
  }
  return rules
}

async function run(db: DashboardDb, requested: RefreshFocus, full: boolean): Promise<Snapshot> {
  syncStatus.running = true
  beginSteps(full)
  const token = loadGithubToken()
  const warnings: string[] = []
  let failed: string | null = null
  try {
    if (full) forgetViewerContext()
    const order: RefreshFocus[] = full ? [requested, requested === 'review' ? 'mine' : 'review'] : [requested]
    const paused = pauseNow()
    if (paused) {
      warnings.push(paused)
      note(paused)
      if (full) {
        const repos = reposIn(db.snapshot())
        try {
          await rulesFor(db, token, repos, true, (message) => {
            note(message)
          })
        } catch (error) {
          warnings.push(messageOf(error))
        }
      }
    } else {
      for (const next of order) {
        const blocked = pauseNow()
        if (blocked) {
          warnings.push(blocked)
          note(blocked)
          break
        }
        try {
          const warning = next === 'mine' ? await refreshMine(db, token, full) : await refreshReview(db, token, full)
          if (warning) warnings.push(warning)
        } catch (error) {
          if (error instanceof GraphqlPaused) {
            warnings.push(error.message)
            note(error.message)
            break
          }
          const message = messageOf(error)
          if (!full && next === requested) failed = message
          else warnings.push(message)
        }
      }
    }
    if (warnings.length > 0 || failed) {
      const snap = db.snapshot()
      db.saveSnapshot({
        viewer: snap.viewer ?? '',
        syncedAt: snap.syncedAt ?? new Date().toISOString(),
        pullRequests: snap.pullRequests,
        reviewPullRequests: snap.reviewPullRequests,
        linearConfigured: snap.linearConfigured,
        warning: joinWarning(warnings.filter(Boolean).join('; ') || null, failed),
        mineSyncedAt: snap.mineSyncedAt,
        reviewSyncedAt: snap.reviewSyncedAt,
      })
    }
    if (failed) throw new Error(failed)
    note('Checking Cursor')
    await refreshCursorSessions(db.cursorSessions(), (prKey, session) => db.saveCursorSession(prKey, session))
    return db.snapshot()
  } finally {
    syncStatus.running = false
    note('Idle')
  }
}

function reposIn(snap: Snapshot): string[] {
  return [...new Set([...snap.pullRequests, ...snap.reviewPullRequests].map((pr) => pr.repo))]
}

async function refreshMine(db: DashboardDb, token: string, forceRules: boolean): Promise<string | null> {
  const previous = new Map(db.snapshot().pullRequests.map((pr) => [pr.key, pr]))
  const fetched = await fetchAuthoredPullRequests(token, (message) => {
    note(message)
  }, (repos) => rulesFor(db, token, repos, forceRules, (message) => {
    note(message)
  }))
  const warning = await withLinear(fetched.pullRequests, fetched.warning)
  const current = db.snapshot()
  db.saveSnapshot({
    viewer: fetched.viewer,
    syncedAt: new Date().toISOString(),
    mineSyncedAt: new Date().toISOString(),
    pullRequests: db.queue.overlay(omitMerged(fetched.pullRequests.map((pr) => carryThreadFeedback(previous.get(pr.key), pr)))),
    reviewPullRequests: current.reviewPullRequests,
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning,
  })
  return warning
}

async function refreshReview(db: DashboardDb, token: string, forceRules: boolean): Promise<string | null> {
  const previous = new Map(db.snapshot().reviewPullRequests.map((pr) => [pr.key, pr]))
  const fetched = await fetchReviewPullRequests(token, (message) => {
    note(message)
  }, (repos) => rulesFor(db, token, repos, forceRules, (message) => {
    note(message)
  }))
  const warning = await withLinear(fetched.pullRequests, fetched.warning)
  const current = db.snapshot()
  db.saveSnapshot({
    viewer: fetched.viewer || current.viewer || '',
    syncedAt: new Date().toISOString(),
    reviewSyncedAt: new Date().toISOString(),
    pullRequests: current.pullRequests,
    reviewPullRequests: fetched.pullRequests.map((pr) => carryThreadFeedback(previous.get(pr.key), pr)),
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning,
  })
  return warning
}

async function withLinear(pullRequests: PullRequest[], warning: string | null): Promise<string | null> {
  const linearKey = process.env.LINEAR_API_KEY
  if (!linearKey) return warning
  note('Reading Linear projects')
  try {
    await enrichLinearProjects(pullRequests, linearKey)
    return warning
  } catch (error) {
    return joinWarning(warning, messageOf(error))
  }
}

function staleFeedback(list: PullRequest[]): PullRequest[] {
  return list.filter((pr) => pr.threadCount > 0 && pr.feedbackAt !== pr.updatedAt)
}

async function readFeedback(db: DashboardDb, next: RefreshFocus): Promise<{ snapshot: Snapshot; pending: number; paused: boolean }> {
  const snap = db.snapshot()
  const list = next === 'review' ? snap.reviewPullRequests : snap.pullRequests
  const stale = staleFeedback(list)
  const paused = graphqlStatus(GRAPHQL_PAUSE_BELOW).paused
  if (paused || stale.length === 0) return { snapshot: snap, pending: stale.length, paused }
  const batch = stale.slice(0, 8)
  syncStatus.running = true
  note(`Reading thread replies (${Math.min(8, stale.length)} of ${stale.length})`)
  try {
    assertGraphql(GRAPHQL_PAUSE_BELOW)
    const token = loadGithubToken()
    const details = await fetchThreadDetails(token, batch.map((pr) => pr.id))
    const viewer = snap.viewer ?? ''
    const updates = new Map<string, PullRequest>()
    for (const pr of batch) {
      const detail = details.get(pr.id)
      if (!detail) continue
      updates.set(pr.key, applyThreadDetails(pr, detail, viewer))
    }
    const apply = (items: PullRequest[]) => items.map((pr) => updates.get(pr.key) ?? pr)
    const saved = db.saveSnapshot({
      viewer: snap.viewer ?? '',
      syncedAt: snap.syncedAt ?? new Date().toISOString(),
      pullRequests: apply(snap.pullRequests),
      reviewPullRequests: apply(snap.reviewPullRequests),
      linearConfigured: snap.linearConfigured,
      warning: snap.warning,
      mineSyncedAt: snap.mineSyncedAt,
      reviewSyncedAt: snap.reviewSyncedAt,
    })
    const pending = staleFeedback(next === 'review' ? saved.reviewPullRequests : saved.pullRequests).length
    return { snapshot: saved, pending, paused: graphqlStatus(GRAPHQL_PAUSE_BELOW).paused }
  } catch (error) {
    if (error instanceof GraphqlPaused) return { snapshot: db.snapshot(), pending: stale.length, paused: true }
    throw error
  } finally {
    syncStatus.running = false
    note('Idle')
  }
}

async function readOne(db: DashboardDb, key: string): Promise<Snapshot> {
  assertGraphql()
  const snap = db.snapshot()
  const current = [...snap.pullRequests, ...snap.reviewPullRequests].find((pr) => pr.key === key)
  if (!current) throw new Error('That pull request is no longer in this list.')
  syncStatus.running = true
  note(`Refreshing #${current.number}`)
  try {
    const token = loadGithubToken()
    const viewerState = await viewerFor(token)
    const loaded = await fetchOnePull(token, current.id)
    if (!loaded || !loaded.open) return dropPull(db, key)
    const rules = await rulesFor(db, token, [current.repo], false, (message) => {
      note(message)
    })
    const rule = rules.get(current.repo)
    const viewer = viewerState.login || snap.viewer || ''
    let mapped = mapOne(current, loaded, viewer, viewerState.teams, rule)
    mapped = keepLinear(current, mapped)
    const linearKey = process.env.LINEAR_API_KEY
    if (linearKey) {
      try {
        await enrichLinearProjects([mapped], linearKey)
      } catch {
        // Keep the GitHub copy of the issue link.
      }
    }
    const latest = db.snapshot()
    const replace = (list: PullRequest[]) => list.map((pr) => (pr.key === mapped.key ? mapped : pr))
    return db.saveSnapshot({
      viewer: viewer || latest.viewer || '',
      syncedAt: new Date().toISOString(),
      pullRequests: replace(latest.pullRequests),
      reviewPullRequests: replace(latest.reviewPullRequests),
      linearConfigured: latest.linearConfigured,
      warning: latest.warning,
      mineSyncedAt: latest.mineSyncedAt,
      reviewSyncedAt: latest.reviewSyncedAt,
    })
  } finally {
    syncStatus.running = false
    note('Idle')
  }
}

function mapOne(
  current: PullRequest,
  loaded: NonNullable<Awaited<ReturnType<typeof fetchOnePull>>>,
  viewer: string,
  teams: string[],
  rule: RepoRules | undefined,
): PullRequest {
  return mapPullRequest(loaded.pull, {
    viewer,
    teams,
    requiredNames: rule?.checks ?? current.requiredCheckNames,
    requiredApprovals: rule?.requiredApprovals ?? current.requiredApprovals,
    dismissStale: rule?.dismissStale ?? current.dismissStale,
    committedAt: loaded.committedAt,
    checks: loaded.checks,
  })
}

function keepLinear(previous: PullRequest, next: PullRequest): PullRequest {
  const prior = new Map(previous.linearIssues.map((issue) => [issue.identifier.toUpperCase(), issue]))
  return {
    ...next,
    linearIssues: next.linearIssues.map((issue) => {
      const old = prior.get(issue.identifier.toUpperCase())
      if (!old) return issue
      return { ...old, title: issue.title ?? old.title, url: issue.url ?? old.url }
    }),
  }
}

function dropPull(db: DashboardDb, key: string): Snapshot {
  const snap = db.snapshot()
  const drop = (list: PullRequest[]) => list.filter((pr) => pr.key !== key)
  return db.saveSnapshot({
    viewer: snap.viewer ?? '',
    syncedAt: snap.syncedAt ?? new Date().toISOString(),
    pullRequests: drop(snap.pullRequests),
    reviewPullRequests: drop(snap.reviewPullRequests),
    linearConfigured: snap.linearConfigured,
    warning: snap.warning,
    mineSyncedAt: snap.mineSyncedAt,
    reviewSyncedAt: snap.reviewSyncedAt,
  })
}
