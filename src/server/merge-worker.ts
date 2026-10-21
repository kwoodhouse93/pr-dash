import path from 'node:path'
import { ciLevel } from '../shared/ci.ts'
import { canSquashMerge, sliceParts, stackReviewBar, upstackBlock } from '../shared/merge.ts'
import { bootAction, cancelGrace, interpretWait, rebasesAfter, type LivePull, type MergeEntry, type MergeStep } from '../shared/queue.ts'
import { buildStacks } from '../shared/stacks.ts'
import type { PullRequest } from '../shared/types.ts'
import type { DashboardDb } from './db.ts'
import { abortRebases, GitCancelled, interruptGit, rebaseOnto } from './git.ts'
import { fetchLivePull, loadGithubToken, squashMergePullRequest, updatePullBase, updatePullBranch } from './github.ts'

const POLL_MS = 20_000

export class MergeRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeRejected'
  }
}

let database: DashboardDb | null = null
let booted: Promise<void> | null = null
let pumping = false

export function startMergeWorker(db: DashboardDb) {
  database = db
  booted = boot().finally(() => {
    booted = null
  })
  void booted.then(() => pump())
}

export function kickMergeWorker() {
  void Promise.resolve(booted).then(() => pump())
}

export async function enqueuePull(db: DashboardDb, key: string) {
  const pr = findPull(db, key)
  if (db.queue.blocksKey(pr.key)) throw new MergeRejected(`#${pr.number} is already in the merge queue.`)
  if (!canSquashMerge(pr)) throw new MergeRejected(`#${pr.number} is not ready to squash into ${pr.defaultBranch}.`)
  const live = await fetchLivePull(loadGithubToken(), pr.repo, pr.number, pr.requiredCheckNames ?? [])
  const fresh = withLive(pr, live)
  if (!canSquashMerge(fresh)) throw new MergeRejected(`#${pr.number} is not ready to squash into ${pr.defaultBranch}.`)
  db.queue.enqueue({
    kind: 'pr',
    repo: pr.repo,
    trunk: pr.defaultBranch,
    title: pr.title,
    steps: [stepOf(pr, live, 'merge')],
  })
  kickMergeWorker()
}

export async function enqueueDownstack(db: DashboardDb, key: string) {
  const snap = db.snapshot()
  const stack = buildStacks(snap.pullRequests).find((item) => item.prs.some((pr) => pr.key === key))
  if (!stack) throw new MergeRejected('That pull request is no longer in this list.')
  const parts = sliceParts(stack.prs, key)
  if (!parts) throw new MergeRejected('The bottom pull request merges on its own.')
  assertSliceReady(parts.merge)
  for (const pr of [...parts.merge, ...parts.restack]) {
    if (db.queue.blocksKey(pr.key)) throw new MergeRejected(`#${pr.number} is already in the merge queue.`)
  }
  const token = loadGithubToken()
  const live = new Map<string, LivePull>()
  for (const pr of [...parts.merge, ...parts.restack]) {
    const next = await fetchLivePull(token, pr.repo, pr.number, pr.requiredCheckNames ?? [])
    if (next.headRef !== pr.headRef) throw new MergeRejected('The stack changed. Refresh and try again.')
    live.set(pr.key, next)
  }
  assertSliceReady(parts.merge.map((pr) => withLive(pr, live.get(pr.key)!)))
  const bottom = parts.merge[parts.merge.length - 1]!
  const top = parts.merge[0]!
  db.queue.enqueue({
    kind: 'stack',
    repo: top.repo,
    trunk: bottom.defaultBranch,
    title: top.title,
    steps: [
      ...[...parts.merge].reverse().map((pr) => stepOf(pr, live.get(pr.key)!, 'merge')),
      ...[...parts.restack].reverse().map((pr) => stepOf(pr, live.get(pr.key)!, 'restack')),
    ],
  })
  kickMergeWorker()
}

export function cancelEntry(db: DashboardDb, id: string) {
  const when = db.queue.requestCancel(id)
  if (when === 'later') interruptGit()
  else {
    const entry = db.queue.get(id)
    if (entry) settle(db, entry)
    kickMergeWorker()
  }
}

export function removeEntry(db: DashboardDb, id: string) {
  const entry = db.queue.get(id)
  db.queue.remove(id)
  if (entry) settle(db, entry)
  kickMergeWorker()
}

export function moveEntry(db: DashboardDb, id: string, direction: 'up' | 'down') {
  db.queue.move(id, direction)
}

function findPull(db: DashboardDb, key: string): PullRequest {
  const pr = db.snapshot().pullRequests.find((item) => item.key === key)
  if (!pr) throw new MergeRejected('That pull request is no longer in this list.')
  return pr
}

function assertSliceReady(mergeTopToBottom: PullRequest[]) {
  const bottom = mergeTopToBottom[mergeTopToBottom.length - 1]
  if (!bottom) throw new MergeRejected('This stack is not ready to merge.')
  if (!canSquashMerge(bottom)) {
    throw new MergeRejected(`#${bottom.number} is not ready to squash into ${bottom.defaultBranch}.`)
  }
  const bar = stackReviewBar(bottom)
  for (const pr of mergeTopToBottom.slice(0, -1)) {
    const reason = upstackBlock(pr, bar)
    if (reason) throw new MergeRejected(reason)
  }
}

function stepOf(pr: PullRequest, live: LivePull, role: 'merge' | 'restack') {
  return {
    prKey: pr.key,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRef: pr.headRef,
    headOid: live.headOid,
    baseRef: pr.baseRef,
    role,
  }
}

function withLive(pr: PullRequest, live: LivePull): PullRequest {
  return {
    ...pr,
    isDraft: live.isDraft,
    mergeable: live.mergeable,
    mergeStateStatus: live.mergeStateStatus,
    reviewDecision: live.reviewDecision,
    baseRef: live.baseRef,
    headRef: live.headRef,
    unresolvedCount: live.unresolvedCount,
    threadsTruncated: live.threadsTruncated,
    committedAt: live.committedAt,
    reviewers: live.reviewers,
    changesRequested: live.changesRequested,
    anyApproval: live.reviewers.some((reviewer) => reviewer.state === 'APPROVED'),
    checks: live.checks,
    ci: ciLevel(live.checks),
    conflict: live.mergeable === 'CONFLICTING' || live.mergeStateStatus === 'DIRTY',
    behind: live.mergeStateStatus === 'BEHIND',
  }
}

function db(): DashboardDb {
  if (!database) throw new Error('The merge queue is not running.')
  return database
}

async function boot() {
  const store = db().queue
  const active = store.snapshot().entries.find((entry) => entry.status === 'active')
  if (!active) return
  const step = active.steps.find((item) => item.status !== 'merged' && item.status !== 'restacked' && item.status !== 'cancelled')
  if (!step) {
    store.markDone(active.id)
    settle(db(), active)
    return
  }
  if (step.status === 'rebasing') {
    await abortRebases(mirrorFor(active.repo))
    const action = bootAction(step.status, 'unknown')
    if (action.type === 'pause') store.fail(active.id, step.id, action.reason)
    return
  }
  if (step.status === 'merging') {
    let github: 'OPEN' | 'MERGED' | 'CLOSED' | 'unknown' = 'unknown'
    try {
      const names = namesFor(step)
      const live = await fetchLivePull(loadGithubToken(), active.repo, step.number, names)
      github = live.state
    } catch {
      github = 'unknown'
    }
    const action = bootAction(step.status, github)
    if (action.type === 'pause') {
      if (action.merged) store.setStep(step.id, 'merged', null)
      store.fail(active.id, action.merged ? null : step.id, action.reason)
    }
    return
  }
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const entry = db().queue.nextRunnable()
      if (!entry) break
      await runEntry(entry)
    }
  } finally {
    pumping = false
    if (db().queue.nextRunnable()) void pump()
  }
}

async function runEntry(entry: MergeEntry) {
  const store = db().queue
  const starting = entry.status === 'queued'
  store.markActive(entry.id)
  store.log(entry.id, 'info', starting ? 'Started.' : 'Resumed.')
  let current = store.get(entry.id) ?? entry
  for (const step of current.steps) {
    if (step.role !== 'merge' || step.status === 'merged') continue
    const ok = await mergeOne(current, step)
    if (!ok) return
    current = store.get(entry.id) ?? current
  }
  current = store.get(entry.id) ?? current
  const unfinished = current.steps.some((step) => step.role === 'restack' && step.status !== 'restacked')
  if (unfinished) {
    store.fail(current.id, null, 'Stopped before every branch above this stack was rebased.')
    return
  }
  store.log(current.id, 'info', 'Finished.')
  store.markDone(current.id)
  settle(db(), current)
}

async function mergeOne(entry: MergeEntry, step: MergeStep): Promise<boolean> {
  const store = db().queue
  let activeId = step.id
  try {
    const already = await waitUntilReady(entry, step)
    if (already === 'stop') return false
    if (already === 'merge') {
      if (stopped(entry.id)) return false
      activeId = step.id
      store.setStep(step.id, 'merging', null)
      store.log(entry.id, 'info', `Squash merging #${step.number}.`)
      await squashMergePullRequest(loadGithubToken(), entry.repo, step.number)
      store.setStep(step.id, 'merged', null)
      store.log(entry.id, 'info', `Squash merged #${step.number}.`)
      const saved = db().snapshot().pullRequests.find((pr) => pr.key === step.prKey)
      if (saved) store.retain(entry.id, saved)
    }
    const fresh = store.get(entry.id)
    if (!fresh) return false
    const plan = rebasesAfter(fresh.steps, step.id, entry.trunk)
    for (const item of plan) {
      if (stopped(entry.id)) return false
      const target = fresh.steps.find((candidate) => candidate.id === item.stepId)
      if (!target) continue
      activeId = target.id
      store.setStep(target.id, 'rebasing', `Onto ${item.onto}`)
      store.log(entry.id, 'info', `Rebasing ${item.branch} onto ${item.onto}.`)
      const oid = await rebaseOnto({
        mirror: mirrorFor(entry.repo),
        remote: `https://github.com/${entry.repo}.git`,
        token: loadGithubToken(),
        trunk: item.onto,
        branch: item.branch,
        cutoffOid: item.cutoffOid,
        expectedOid: target.headOid,
        shouldStop: () => store.isCancelRequested(entry.id),
      })
      store.setHeadOid(target.id, oid)
      if (item.setBaseTo) {
        store.log(entry.id, 'info', `Setting #${target.number} to target ${item.setBaseTo}.`)
        await updatePullBase(loadGithubToken(), entry.repo, target.number, item.setBaseTo)
      }
      if (item.finishRestack) {
        store.setStep(target.id, 'restacked', null)
        store.log(entry.id, 'info', `Rebased #${target.number} onto ${entry.trunk}.`)
      } else {
        store.setStep(target.id, 'queued', `Rebased onto ${item.onto}.`)
      }
      const updated = store.get(entry.id)
      if (updated) {
        const rewritten = updated.steps.find((candidate) => candidate.id === target.id)
        if (rewritten) target.headOid = rewritten.headOid
      }
    }
    return !stopped(entry.id)
  } catch (error) {
    if (error instanceof GitCancelled || store.isCancelRequested(entry.id)) {
      store.finishCancelled(entry.id)
      settle(db(), store.get(entry.id) ?? entry)
      return false
    }
    const message = error instanceof Error ? error.message : 'Merge failed'
    store.fail(entry.id, activeId, message)
    return false
  }
}

async function waitUntilReady(entry: MergeEntry, step: MergeStep): Promise<'merge' | 'merged' | 'stop'> {
  const store = db().queue
  store.setStep(step.id, 'waiting', null)
  let unexplained = 0
  let updatedFor = ''
  let lastReason = ''
  let cancelledSince: number | null = null
  for (;;) {
    if (stopped(entry.id)) return 'stop'
    const names = namesFor(step)
    let live: LivePull
    try {
      live = await fetchLivePull(loadGithubToken(), entry.repo, step.number, names)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub request failed'
      note(entry.id, `Could not read #${step.number}. ${message}`, lastReason)
      lastReason = message
      if (!(await pause(entry.id))) return 'stop'
      continue
    }
    const decision = interpretWait(live, entry.trunk, names)
    if (decision.action === 'ready') return 'merge'
    if (decision.action === 'merged') {
      store.setStep(step.id, 'merged', null)
      store.log(entry.id, 'info', `#${step.number} is already merged.`)
      const saved = db().snapshot().pullRequests.find((pr) => pr.key === step.prKey)
      if (saved) store.retain(entry.id, saved)
      return 'merged'
    }
    if (decision.action === 'fail') {
      store.fail(entry.id, step.id, decision.reason)
      return 'stop'
    }
    if (decision.action === 'behind') {
      cancelledSince = null
      if (updatedFor === decision.headOid) {
        store.fail(entry.id, step.id, `#${step.number} is still behind ${entry.trunk} after updating it.`)
        return 'stop'
      }
      updatedFor = decision.headOid
      store.log(entry.id, 'info', `Updating #${step.number} with ${entry.trunk}.`)
      try {
        await updatePullBranch(loadGithubToken(), entry.repo, step.number, decision.headOid)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update the branch'
        store.fail(entry.id, step.id, message)
        return 'stop'
      }
      if (!(await pause(entry.id))) {
        stopped(entry.id)
        return 'stop'
      }
      continue
    }
    if (decision.unexplained) {
      unexplained += 1
      if (unexplained >= 3) {
        store.fail(entry.id, step.id, decision.reason)
        return 'stop'
      }
    } else {
      unexplained = 0
    }
    const grace = cancelGrace(cancelledSince, Date.now(), decision.action === 'wait' && decision.restarting != null)
    cancelledSince = grace.since
    if (grace.expired && decision.action === 'wait' && decision.restarting) {
      store.fail(entry.id, step.id, `#${step.number} required check was cancelled and did not restart: ${decision.restarting.join(', ')}.`)
      return 'stop'
    }
    lastReason = note(entry.id, decision.reason, lastReason)
    if (!(await pause(entry.id))) {
      stopped(entry.id)
      return 'stop'
    }
  }
}

function note(entryId: string, reason: string, previous: string): string {
  if (reason === previous) return previous
  db().queue.log(entryId, 'info', reason)
  return reason
}

function stopped(entryId: string): boolean {
  if (!db().queue.isCancelRequested(entryId)) return false
  db().queue.finishCancelled(entryId)
  settle(db(), db().queue.get(entryId) ?? { ...emptyEntry(entryId), steps: [] })
  return true
}

function emptyEntry(id: string): MergeEntry {
  return {
    id,
    position: 0,
    kind: 'pr',
    repo: '',
    trunk: '',
    title: '',
    status: 'cancelled',
    error: null,
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    finishedAt: null,
    steps: [],
    logs: [],
  }
}

async function pause(entryId: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_MS) {
    if (db().queue.isCancelRequested(entryId)) return false
    await delay(Math.min(1_000, POLL_MS - (Date.now() - start)))
  }
  return !db().queue.isCancelRequested(entryId)
}

function namesFor(step: MergeStep): string[] {
  return db().snapshot().pullRequests.find((pr) => pr.key === step.prKey)?.requiredCheckNames ?? []
}

function settle(database: DashboardDb, entry: MergeEntry) {
  const keys = new Set(database.queue.takeRetained(entry.id))
  for (const step of entry.steps) {
    if (step.status === 'merged') keys.add(step.prKey)
  }
  if (keys.size === 0) return
  const snap = database.snapshot()
  database.saveSnapshot({
    viewer: snap.viewer ?? '',
    syncedAt: snap.syncedAt ?? new Date().toISOString(),
    pullRequests: snap.pullRequests.filter((pr) => !keys.has(pr.key)),
    linearConfigured: snap.linearConfigured,
    warning: snap.warning,
  })
}

function mirrorFor(repo: string): string {
  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'pr-dash.sqlite')
  const [owner, name] = repo.split('/')
  return path.join(path.dirname(dbPath), 'mirrors', owner ?? 'repo', `${name ?? repo}.git`)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
