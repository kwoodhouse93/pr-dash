import { carryThreadFeedback } from '../shared/feedback.ts'
import { mergeLinkedIssues } from '../shared/linear.ts'
import { applyThreadDetails, mapPullRequest } from '../shared/map.ts'
import { refreshSteps, stepIndex, type RefreshStep } from '../shared/progress.ts'
import { pullKeyRepo, replaceRepoPulls } from '../shared/repos.ts'
import { landedMergeVisible, type RemotePullState } from '../shared/queue.ts'
import type { PullRequest, Snapshot } from '../shared/types.ts'
import { GRAPHQL_PAUSE_BELOW } from '../shared/budget.ts'
import { rulesFresh } from '../shared/rules.ts'
import { refreshCursorSessions } from './cursor.ts'
import type { DashboardDb } from './db.ts'
import { processMergeWatches } from './merge-worker.ts'
import {
  GraphqlPaused,
  assertGraphql,
  fetchAuthoredPullRequests,
  fetchOnePull,
  fetchPullState,
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
import { withRequestSignal } from './request-signal.ts'
import { createSyncQueue, SyncCancelled, type SyncKind } from './sync-queue.ts'

export { SyncCancelled }

export const syncStatus = { running: false, message: 'Idle', completed: 0, total: 0 }

const jobs = createSyncQueue({
  onStart(job) {
    steps = []
    stepAt = 0
    syncStatus.running = true
    syncStatus.completed = 0
    syncStatus.total = 0
    syncStatus.message = startMessage(job.kind)
  },
  onIdle() {
    steps = []
    stepAt = 0
    syncStatus.running = false
    syncStatus.completed = 0
    syncStatus.total = 0
    syncStatus.message = 'Idle'
  },
})

function startMessage(kind: SyncKind): string {
  switch (kind) {
    case 'full':
      return 'Starting full sync'
    case 'rules':
      return 'Reading rulesets'
    case 'list':
      return 'Starting refresh'
    case 'pull':
      return 'Refreshing pull request'
    case 'threads':
      return 'Reading thread replies'
  }
}

export function describeSync(db: DashboardDb) {
  const queue = jobs.view()
  return {
    running: queue.activity != null,
    message: syncStatus.message,
    completed: syncStatus.completed,
    total: syncStatus.total,
    activity: queue.activity,
    queue: queue.upcoming,
    history: queue.history,
    graphql: graphqlStatus(GRAPHQL_PAUSE_BELOW),
    rules: db.ruleCache().map((rule) => ({ repo: rule.repo, fetchedAt: rule.fetchedAt })),
  }
}

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

export function refreshSnapshot(
  db: DashboardDb,
  next: RefreshFocus = 'mine',
  options?: { full?: boolean; interactive?: boolean },
): Promise<Snapshot> {
  const full = options?.full === true
  const spec = {
    kind: (full ? 'full' : 'list') as SyncKind,
    key: `${next}:${full ? 'full' : 'tab'}`,
    summary: () => '',
    work: (signal: AbortSignal) => withRequestSignal(signal, () => run(db, next, full, signal)),
  }
  return options?.interactive ? jobs.enqueueInteractive(spec) : jobs.enqueue(spec)
}

/** The list a connected dashboard is showing. Background refresh keeps that one warm first. */
let watchedFocus: RefreshFocus = 'mine'

export function noteListFocus(focus: RefreshFocus) {
  watchedFocus = focus
}

const BACKGROUND_MS = 60_000

function listAge(db: DashboardDb, focus: RefreshFocus): number {
  const snap = db.snapshot()
  const stamp = focus === 'review' ? snap.reviewSyncedAt : snap.mineSyncedAt
  if (!stamp) return Number.POSITIVE_INFINITY
  const at = Date.parse(stamp)
  return Number.isFinite(at) ? Date.now() - at : Number.POSITIVE_INFINITY
}

function refreshIfDue(db: DashboardDb, focus: RefreshFocus) {
  if (listAge(db, focus) < BACKGROUND_MS - 5_000) return
  void refreshSnapshot(db, focus).catch(() => undefined)
}

/**
 * Keep the open list moving while this process is up, including when the browser tab is hidden.
 * Only that list runs here. The other one refreshes when it is opened, so a long review search
 * cannot sit ahead of the list on screen.
 */
export function startBackgroundSync(db: DashboardDb) {
  const run = () => {
    if (db.watchedRepos().length === 0) return
    if (pauseNow()) return
    refreshIfDue(db, watchedFocus)
  }
  const first = setTimeout(run, 3_000)
  const timer = setInterval(run, BACKGROUND_MS)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

export function enqueueSync(db: DashboardDb, kind: 'full' | 'rules', focus: RefreshFocus = 'mine') {
  jobs.enqueueUser({
    kind,
    summary: (snapshot: Snapshot) => snapshot.warning?.trim() || (db.watchedRepos().length === 0 ? 'No repositories selected' : 'Finished'),
    work: (signal) => withRequestSignal(signal, () => (kind === 'rules' ? runRules(db, signal) : run(db, focus, true, signal))),
  })
  return describeSync(db)
}

export function cancelQueuedSync(db: DashboardDb, id: string) {
  jobs.cancel(id)
  return describeSync(db)
}

export function loadThreadFeedback(db: DashboardDb, next: RefreshFocus): Promise<{ snapshot: Snapshot; pending: number; paused: boolean }> {
  return jobs.enqueue({
    kind: 'threads',
    key: `threads:${next}`,
    summary: () => '',
    work: (signal) => withRequestSignal(signal, () => readFeedback(db, next, signal)),
  })
}

export function refreshPull(db: DashboardDb, key: string): Promise<Snapshot> {
  return jobs.enqueueInteractive({
    kind: 'pull',
    key: `pull:${key}`,
    summary: () => '',
    work: (signal) => withRequestSignal(signal, () => readOne(db, key, signal)),
  })
}

function joinWarning(left: string | null, right: string | null): string | null {
  if (left && right) return `${left}; ${right}`
  return left ?? right
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Refresh failed'
}

function cancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || error instanceof SyncCancelled) return true
  return error instanceof Error && error.name === 'AbortError'
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
  strict = false,
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
      if (cancelled(error)) throw new SyncCancelled()
      if (strict || !needed.every((repo) => cached.has(repo))) throw error
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

async function run(db: DashboardDb, requested: RefreshFocus, full: boolean, signal: AbortSignal): Promise<Snapshot> {
  beginSteps(full)
  const warnings: string[] = []
  let failed: string | null = null
  try {
    const watched = db.watchedRepos()
    if (watched.length === 0) {
      note('No repositories selected')
      return db.snapshot()
    }
    const token = loadGithubToken()
    if (full) forgetViewerContext()
    const order: RefreshFocus[] = full ? [requested, requested === 'review' ? 'mine' : 'review'] : [requested]
    const paused = pauseNow()
    if (paused) {
      warnings.push(paused)
      note(paused)
      if (full) {
        const selected = new Set(watched)
        const repos = reposIn(db.snapshot()).filter((repo) => selected.has(repo))
        if (signal.aborted) throw new SyncCancelled()
        try {
          await rulesFor(db, token, repos, true, (message) => {
            note(message)
          })
        } catch (error) {
          if (cancelled(error, signal)) throw new SyncCancelled()
          warnings.push(messageOf(error))
        }
      }
    } else {
      for (const next of order) {
        if (signal.aborted) throw new SyncCancelled()
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
          if (cancelled(error, signal)) throw new SyncCancelled()
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
    if (signal.aborted) throw new SyncCancelled()
    note('Checking Cursor')
    const selected = new Set(db.watchedRepos())
    const sessions = db.cursorSessions().filter(({ prKey }) => {
      const repo = pullKeyRepo(prKey)
      return repo != null && selected.has(repo)
    })
    await refreshCursorSessions(sessions, (prKey, session) => db.saveCursorSession(prKey, session))
    return db.snapshot()
  } catch (error) {
    if (cancelled(error, signal)) throw new SyncCancelled()
    throw error
  }
}

async function runRules(db: DashboardDb, signal: AbortSignal): Promise<Snapshot> {
  note('Reading rulesets')
  const watched = db.watchedRepos()
  if (watched.length === 0) {
    note('No repositories selected')
    return db.snapshot()
  }
  if (signal.aborted) throw new SyncCancelled()
  const token = loadGithubToken()
  await rulesFor(db, token, watched, true, (message) => note(message), true)
  return db.snapshot()
}

function reposIn(snap: Snapshot): string[] {
  return [...new Set([...snap.pullRequests, ...snap.reviewPullRequests].map((pr) => pr.repo))]
}

function knownPulls(db: DashboardDb): PullRequest[] {
  const snap = db.snapshot()
  const byId = new Map<string, PullRequest>()
  for (const pr of [...snap.pullRequests, ...snap.reviewPullRequests]) {
    const current = byId.get(pr.id)
    if (!current || (!current.checkCursor && pr.checkCursor)) byId.set(pr.id, pr)
  }
  return [...byId.values()]
}

async function refreshMine(db: DashboardDb, token: string, forceRules: boolean): Promise<string | null> {
  const watched = db.watchedRepos()
  const stored = db.snapshot().pullRequests
  const previous = new Map(stored.map((pr) => [pr.key, pr]))
  const fetched = await fetchAuthoredPullRequests(token, (message) => {
    note(message)
  }, watched, (repos) => rulesFor(db, token, repos, forceRules, (message) => {
    note(message)
  }), { previous: knownPulls(db), forceChecks: forceRules })
  const warning = await withLinear(db, fetched.pullRequests, fetched.warning)
  await confirmLandedMerges(db, token, fetched.pullRequests)
  const current = db.snapshot()
  const next = db.queue.overlay(fetched.pullRequests.map((pr) => carryThreadFeedback(previous.get(pr.key), pr)))
  db.saveSnapshot({
    viewer: fetched.viewer || current.viewer || '',
    syncedAt: new Date().toISOString(),
    mineSyncedAt: new Date().toISOString(),
    pullRequests: replaceRepoPulls(current.pullRequests, next, watched),
    reviewPullRequests: current.reviewPullRequests,
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning,
  })
  await processMergeWatches(db)
  return warning
}

async function refreshReview(db: DashboardDb, token: string, forceRules: boolean): Promise<string | null> {
  const watched = db.watchedRepos()
  const previous = new Map(db.snapshot().reviewPullRequests.map((pr) => [pr.key, pr]))
  const fetched = await fetchReviewPullRequests(token, (message) => {
    note(message)
  }, watched, (repos) => rulesFor(db, token, repos, forceRules, (message) => {
    note(message)
  }), { previous: knownPulls(db), forceChecks: forceRules })
  const warning = await withLinear(db, fetched.pullRequests, fetched.warning)
  const current = db.snapshot()
  db.saveSnapshot({
    viewer: fetched.viewer || current.viewer || '',
    syncedAt: new Date().toISOString(),
    reviewSyncedAt: new Date().toISOString(),
    pullRequests: current.pullRequests,
    reviewPullRequests: replaceRepoPulls(
      current.reviewPullRequests,
      fetched.pullRequests.map((pr) => carryThreadFeedback(previous.get(pr.key), pr)),
      watched,
    ),
    linearConfigured: Boolean(process.env.LINEAR_API_KEY),
    warning,
  })
  return warning
}

async function confirmLandedMerges(db: DashboardDb, token: string, pullRequests: PullRequest[]): Promise<void> {
  const landed = db.queue.landedKeys()
  if (landed.size === 0) return
  for (const pr of pullRequests) {
    if (!landed.has(pr.key)) continue
    let state: RemotePullState = 'unknown'
    try {
      state = await fetchPullState(token, pr.repo, pr.number)
    } catch {
      state = 'unknown'
    }
    if (landedMergeVisible(state)) db.queue.releaseHold(pr.key)
    else if (state === 'MERGED' || state === 'CLOSED') db.queue.clearHoldRelease(pr.key)
  }
}

async function withLinear(db: DashboardDb, pullRequests: PullRequest[], warning: string | null): Promise<string | null> {
  applyRememberedLinks(db, pullRequests)
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

async function readFeedback(
  db: DashboardDb,
  next: RefreshFocus,
  signal: AbortSignal,
): Promise<{ snapshot: Snapshot; pending: number; paused: boolean }> {
  const snap = db.snapshot()
  const watched = new Set(snap.repos)
  const list = (next === 'review' ? snap.reviewPullRequests : snap.pullRequests).filter((pr) => watched.has(pr.repo))
  const stale = staleFeedback(list)
  const paused = graphqlStatus(GRAPHQL_PAUSE_BELOW).paused
  if (paused || stale.length === 0) return { snapshot: snap, pending: stale.length, paused }
  if (signal.aborted) throw new SyncCancelled()
  const batch = stale.slice(0, 8)
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
    if (cancelled(error, signal)) throw new SyncCancelled()
    if (error instanceof GraphqlPaused) return { snapshot: db.snapshot(), pending: stale.length, paused: true }
    throw error
  }
}

async function readOne(db: DashboardDb, key: string, signal: AbortSignal): Promise<Snapshot> {
  assertGraphql()
  const snap = db.snapshot()
  const current = [...snap.pullRequests, ...snap.reviewPullRequests].find((pr) => pr.key === key)
  if (!current) throw new Error('That pull request is no longer in this list.')
  if (signal.aborted) throw new SyncCancelled()
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
    mapped = mergeLinkedIssues(mapped, db.linearLinks().get(mapped.key) ?? [])
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
    db.saveSnapshot({
      viewer: viewer || latest.viewer || '',
      syncedAt: new Date().toISOString(),
      pullRequests: replace(latest.pullRequests),
      reviewPullRequests: replace(latest.reviewPullRequests),
      linearConfigured: latest.linearConfigured,
      warning: latest.warning,
      mineSyncedAt: latest.mineSyncedAt,
      reviewSyncedAt: latest.reviewSyncedAt,
    })
    await processMergeWatches(db)
    return db.snapshot()
  } catch (error) {
    if (cancelled(error, signal)) throw new SyncCancelled()
    throw error
  }
}

function mapOne(
  current: PullRequest,
  loaded: NonNullable<Awaited<ReturnType<typeof fetchOnePull>>>,
  viewer: string,
  teams: string[],
  rule: RepoRules | undefined,
): PullRequest {
  const mapped = mapPullRequest(loaded.pull, {
    viewer,
    teams,
    requiredNames: rule?.checks ?? current.requiredCheckNames,
    requiredApprovals: rule?.requiredApprovals ?? current.requiredApprovals,
    dismissStale: rule?.dismissStale ?? current.dismissStale,
    committedAt: loaded.committedAt,
    checks: loaded.checks,
    suites: loaded.suites,
    behindBy: loaded.behindBy,
  })
  return loaded.cursor ? { ...mapped, checkCursor: loaded.cursor } : mapped
}

function applyRememberedLinks(db: DashboardDb, pullRequests: PullRequest[]): void {
  const links = db.linearLinks()
  if (links.size === 0) return
  for (const pr of pullRequests) {
    const merged = mergeLinkedIssues(pr, links.get(pr.key) ?? [])
    if (merged !== pr) pr.linearIssues = merged.linearIssues
  }
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
