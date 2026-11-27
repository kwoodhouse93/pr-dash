import { ciLevel } from '../shared/ci.ts'
import { isBehindBase } from '../shared/map.ts'
import { canSquashMerge, sliceParts, stackReviewBar, unapprovedMergeBlock, upstackBlock } from '../shared/merge.ts'
import { reviewBypassBlock } from '../shared/rules.ts'
import { bootAction, cancelGrace, interpretWait, rebasesDue, type LivePull, type MergeEntry, type MergeStep } from '../shared/queue.ts'
import { buildStacks, mergeLine, stackOf } from '../shared/stacks.ts'
import type { PullRequest } from '../shared/types.ts'
import type { DashboardDb } from './db.ts'
import { abortRebases, GitCancelled, interruptGit, mirrorPath, rebaseOnto } from './git.ts'
import { loadGithubToken } from './github-client.ts'
import { commitContains, fetchLivePull, rerunWorkflows, squashMergePullRequest, updatePullBase, updatePullBranch } from './github-pull.ts'
import { readRulesets } from './github.ts'

import { PULL_GONE, Refused } from './errors.ts'

const POLL_MS = 20_000

export class MergeRejected extends Refused {
  constructor(message: string) {
    super(message, 409)
  }
}

let database: DashboardDb | null = null
let booted: Promise<void> | null = null
const pumping = new Set<string>()

export function startMergeWorker(db: DashboardDb) {
  database = db
  booted = boot().finally(() => {
    booted = null
  })
  void booted.then(() => pumpAll())
}

export function kickMergeWorker() {
  void Promise.resolve(booted).then(() => pumpAll())
}

/** `unapproved` queues a pull request whose required approval is the one thing it lacks. */
export async function enqueuePull(db: DashboardDb, key: string, unapproved = false) {
  const pr = findPull(db, key)
  if (db.queue.blocksKey(pr.key)) throw new MergeRejected(`#${pr.number} is already in the merge queue.`)
  const block = (item: PullRequest) =>
    unapproved ? unapprovedMergeBlock(item) : canSquashMerge(item) ? null : `#${pr.number} is not ready to squash into ${pr.defaultBranch}.`
  const stale = block(pr)
  if (stale) throw new MergeRejected(stale)
  const token = loadGithubToken()
  const live = await fetchLivePull(token, pr.repo, pr.number, pr.requiredCheckNames ?? [])
  const reason = block(withLive(pr, live))
  if (reason) throw new MergeRejected(reason)
  if (unapproved) {
    const refused = reviewBypassBlock(await readRulesets(token, pr.repo))
    if (refused) throw new MergeRejected(refused)
  }
  const entry = db.queue.enqueue({
    kind: unapproved ? 'unapproved' : 'pr',
    repo: pr.repo,
    trunk: pr.defaultBranch,
    title: pr.title,
    steps: [stepOf(pr, live, 'merge', null)],
  })
  if (unapproved) db.queue.log(entry.id, 'info', `Merging #${pr.number} without its required approval.`)
  kickMergeWorker()
}

export async function enqueueDownstack(db: DashboardDb, key: string) {
  const snap = db.snapshot()
  const line = mergeLineFor(snap.pullRequests, key)
  if (!line) throw new MergeRejected(PULL_GONE)
  const parts = sliceParts(line, key)
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
  const affected = [...parts.merge, ...parts.restack]
  // A branch left behind by a push to the one below it cannot be cut from that branch's head once it merges.
  for (const pr of affected) {
    const parent = affected.find((item) => item.headRef === pr.baseRef && item.key !== pr.key)
    if (!parent) continue
    if (!(await commitContains(token, pr.repo, live.get(parent.key)!.headOid, live.get(pr.key)!.headOid))) {
      throw new MergeRejected(`#${pr.number} is not built on the latest commit of #${parent.number}. Restack and push the stack, then try again.`)
    }
  }
  // Each branch records the head it is built on, so it can be cut from that commit after its parent is rewritten.
  const baseOid = (pr: PullRequest) => {
    const parent = affected.find((item) => item.headRef === pr.baseRef && item.key !== pr.key)
    return parent ? live.get(parent.key)!.headOid : null
  }
  db.queue.enqueue({
    kind: 'stack',
    repo: top.repo,
    trunk: bottom.defaultBranch,
    title: top.title,
    steps: [
      ...[...parts.merge].reverse().map((pr) => stepOf(pr, live.get(pr.key)!, 'merge', baseOid(pr))),
      ...[...parts.restack].reverse().map((pr) => stepOf(pr, live.get(pr.key)!, 'restack', baseOid(pr))),
    ],
  })
  kickMergeWorker()
}

/** Top to bottom: every branch that has to be restacked, then the chosen pull request down to the trunk. */
function mergeLineFor(pulls: PullRequest[], key: string): PullRequest[] | null {
  const stack = stackOf(buildStacks(pulls), key)
  return stack ? mergeLine(stack, key) : null
}

export function cancelEntry(db: DashboardDb, id: string) {
  const repo = db.queue.get(id)?.repo
  const when = db.queue.requestCancel(id)
  if (when === 'later') {
    if (repo) interruptGit(mirrorFor(repo))
  }
  else {
    const entry = db.queue.get(id)
    if (entry) settle(db, entry)
    kickMergeWorker()
  }
}

/** Re-reads each unfinished pull request, then puts the held entry back in line. */
export async function retryEntry(db: DashboardDb, id: string) {
  const entry = db.queue.get(id)
  if (!entry) throw new MergeRejected('That merge is no longer in the queue.')
  if (entry.status !== 'failed') throw new MergeRejected('Only a held merge can be retried.')
  const token = loadGithubToken()
  const pulls = db.snapshot().pullRequests
  const live: { stepId: string; headOid: string; onTrunk: boolean; restacked: boolean }[] = []
  for (const step of entry.steps) {
    if (step.status === 'merged' || step.status === 'restacked' || step.status === 'cancelled') continue
    const names = pulls.find((pr) => pr.key === step.prKey)?.requiredCheckNames ?? []
    const now = await fetchLivePull(token, entry.repo, step.number, names)
    // GitHub moves a pull request onto the trunk by itself when the branch below it merges and is deleted,
    // without rebasing it. Only a new head on the trunk means someone moved it there themselves.
    const onTrunk = now.baseRef === entry.trunk && (step.baseOid == null || now.headOid !== step.headOid)
    live.push({
      stepId: step.id,
      headOid: now.headOid,
      onTrunk,
      // A branch that only needed moving off the stack is finished once it is on trunk, or is no longer open.
      restacked: step.role === 'restack' && (now.state !== 'OPEN' || onTrunk),
    })
  }
  try {
    db.queue.retry(id, live)
  } catch (error) {
    throw new MergeRejected(error instanceof Error ? error.message : 'Could not retry that merge.')
  }
  kickMergeWorker()
}

export function moveEntry(db: DashboardDb, id: string, direction: 'up' | 'down') {
  db.queue.move(id, direction)
}

function findPull(db: DashboardDb, key: string): PullRequest {
  const pr = db.snapshot().pullRequests.find((item) => item.key === key)
  if (!pr) throw new MergeRejected(PULL_GONE)
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

function stepOf(pr: PullRequest, live: LivePull, role: 'merge' | 'restack', baseOid: string | null) {
  return {
    prKey: pr.key,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRef: pr.headRef,
    headOid: live.headOid,
    baseRef: pr.baseRef,
    baseOid,
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
    behind: isBehindBase(live.mergeStateStatus, live.behindBy),
  }
}

function db(): DashboardDb {
  if (!database) throw new Error('The merge queue is not running.')
  return database
}

async function boot() {
  for (const entry of db().queue.snapshot().entries) {
    if (entry.status === 'active') await recover(entry)
  }
}

/** An entry that was in flight when the server stopped either carries on or is held aside. */
async function recover(active: MergeEntry) {
  const store = db().queue
  const step = active.steps.find((item) => item.status !== 'merged' && item.status !== 'restacked' && item.status !== 'cancelled')
  if (!step) {
    store.markDone(active.id)
    settle(db(), active)
    return
  }
  if (step.status === 'rebasing') {
    await abortRebases(mirrorFor(active.repo))
    const action = bootAction(step.status, 'unknown')
    if (action.type === 'hold') store.fail(active.id, step.id, action.reason)
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
    if (action.type === 'hold') {
      if (action.merged) store.setStep(step.id, 'merged', null)
      store.fail(active.id, action.merged ? null : step.id, action.reason)
    }
    return
  }
}

function pumpAll() {
  for (const repo of db().queue.runnableRepos()) void pump(repo)
}

/** One line per repo: a slow merge in one repo does not hold up another. */
async function pump(repo: string) {
  if (pumping.has(repo)) return
  pumping.add(repo)
  try {
    for (;;) {
      const entry = db().queue.nextRunnable(repo)
      if (!entry) break
      await runEntry(entry)
    }
  } finally {
    pumping.delete(repo)
    if (db().queue.nextRunnable(repo)) void pump(repo)
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
    if (!(await moveDue(entry.id))) return
    current = store.get(entry.id) ?? current
    if (!(await mergeOne(current, step))) return
  }
  if (!(await moveDue(entry.id))) return
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
  try {
    for (let moved = 0; ; moved += 1) {
      const ready = await waitUntilReady(entry, step)
      if (ready === 'stop') return false
      if (ready === 'merged') break
      if (stopped(entry.id)) return false
      store.setStep(step.id, 'merging', null)
      store.log(entry.id, 'info', `Squash merging #${step.number}.`)
      // Only the commit that was just checked may merge. GitHub can report an old head for a while after a push.
      if ((await squashMergePullRequest(loadGithubToken(), entry.repo, step.number, ready.headOid)) === 'merged') {
        store.setStep(step.id, 'merged', null)
        store.log(entry.id, 'info', `Squash merged #${step.number}.`)
        const saved = savedPull(step)
        if (saved) store.retain(entry.id, saved)
        break
      }
      if (moved + 1 >= STALE_HEAD_LIMIT) {
        store.fail(entry.id, step.id, `#${step.number} kept getting a new head before it could merge.`)
        return false
      }
      store.log(entry.id, 'info', `#${step.number} has a newer head than the one that was checked. Checking again.`)
      if (!(await pause(entry.id))) return !stopped(entry.id)
    }
    return !stopped(entry.id)
  } catch (error) {
    halt(entry, step.id, error)
    return false
  }
}

/**
 * Moves onto the trunk each branch built directly on one that has merged. Branches further up
 * stay where they are until the one below them merges, so their CI only runs once they are next.
 */
async function moveDue(entryId: string): Promise<boolean> {
  const store = db().queue
  const entry = store.get(entryId)
  if (!entry) return false
  let activeId: string | null = null
  try {
    for (const item of rebasesDue(entry.steps)) {
      if (stopped(entry.id)) return false
      const target = entry.steps.find((candidate) => candidate.id === item.stepId)
      if (!target) continue
      activeId = target.id
      store.setStep(target.id, 'rebasing', `Onto ${entry.trunk}`)
      // Retarget before rewriting: done twice it is harmless, and a rebase that fails leaves the step to rebase again.
      await retarget(entry, target)
      store.log(entry.id, 'info', `Rebasing ${item.branch} onto ${entry.trunk}.`)
      const oid = await rebaseOnto({
        mirror: mirrorFor(entry.repo),
        remote: `https://github.com/${entry.repo}.git`,
        token: loadGithubToken(),
        trunk: entry.trunk,
        branch: item.branch,
        cutoffOid: item.cutoffOid,
        expectedOid: item.expectedOid,
        shouldStop: () => store.isCancelRequested(entry.id),
      })
      store.setRebased(target.id, oid)
      if (item.finishRestack) {
        store.setStep(target.id, 'restacked', null)
        store.log(entry.id, 'info', `Rebased #${target.number} onto ${entry.trunk}.`)
      } else {
        store.setStep(target.id, 'queued', `Rebased onto ${entry.trunk}.`)
      }
    }
    return !stopped(entry.id)
  } catch (error) {
    halt(entry, activeId, error)
    return false
  }
}

/** Points the pull request at the trunk. GitHub may already have, when the branch below it was deleted on merge. */
async function retarget(entry: MergeEntry, step: MergeStep) {
  const token = loadGithubToken()
  try {
    await updatePullBase(token, entry.repo, step.number, entry.trunk)
  } catch (error) {
    const live = await fetchLivePull(token, entry.repo, step.number, namesFor(step)).catch(() => null)
    if (live?.baseRef !== entry.trunk) throw error
    return
  }
  db().queue.log(entry.id, 'info', `Set #${step.number} to target ${entry.trunk}.`)
}

function halt(entry: MergeEntry, activeId: string | null, error: unknown) {
  const queue = db().queue
  if (error instanceof GitCancelled || queue.isCancelRequested(entry.id)) {
    queue.finishCancelled(entry.id)
    settle(db(), queue.get(entry.id) ?? entry)
    return
  }
  const message = error instanceof Error ? error.message : 'Merge failed'
  queue.fail(entry.id, activeId, message)
}

const STALE_HEAD_LIMIT = 5

/** Resolves with the head that passed every gate, which is the only commit that may then merge. */
async function waitUntilReady(entry: MergeEntry, step: MergeStep): Promise<{ headOid: string } | 'merged' | 'stop'> {
  const store = db().queue
  store.setStep(step.id, 'waiting', null)
  let unexplained = 0
  let updatedFor = ''
  let staleHeads = 0
  let lastReason = ''
  let cancelledSince: number | null = null
  const rerun = new Set<number>()
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
    const decision = interpretWait(live, entry.trunk, names, entry.kind === 'unapproved' ? { requiredApprovals: savedPull(step)?.requiredApprovals ?? 1 } : null)
    if (decision.action === 'ready') return { headOid: live.headOid }
    if (decision.action === 'merged') {
      store.setStep(step.id, 'merged', null)
      store.log(entry.id, 'info', `#${step.number} is already merged.`)
      const saved = savedPull(step)
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
      let result: 'updated' | 'moved'
      try {
        result = await updatePullBranch(loadGithubToken(), entry.repo, step.number, decision.headOid)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update the branch'
        store.fail(entry.id, step.id, message)
        return 'stop'
      }
      if (result === 'moved') {
        // GitHub reads a branch's old head for a short while after a push, such as the rebase that just moved it onto the trunk.
        updatedFor = ''
        staleHeads += 1
        if (staleHeads >= STALE_HEAD_LIMIT) {
          store.fail(entry.id, step.id, `GitHub kept reporting an old head for #${step.number}.`)
          return 'stop'
        }
        store.log(entry.id, 'info', `#${step.number} has a newer head than GitHub reported. Checking again.`)
      } else {
        staleHeads = 0
      }
      if (!(await pause(entry.id))) {
        stopped(entry.id)
        return 'stop'
      }
      continue
    }
    const shadowed = (live.shadowed ?? []).filter((run) => !rerun.has(run.runId))
    if (shadowed.length > 0) {
      for (const run of shadowed) rerun.add(run.runId)
      const workflows = shadowed.map((run) => run.workflow).join(', ')
      store.log(entry.id, 'info', `Rerunning ${workflows} on #${step.number}. GitHub counts a cancelled duplicate run over the one that passed.`)
      const result = await rerunWorkflows(
        loadGithubToken(),
        shadowed.map((run) => ({ repo: entry.repo, runId: run.runId })),
        'all',
      ).catch((error: unknown) => ({ errors: [error instanceof Error ? error.message : 'GitHub request failed'] }))
      for (const message of result.errors) store.log(entry.id, 'error', `Could not rerun. ${message}`)
      if (result.errors.length === 0) {
        unexplained = 0
        cancelledSince = null
        if (!(await pause(entry.id))) {
          stopped(entry.id)
          return 'stop'
        }
        continue
      }
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

function savedPull(step: MergeStep): PullRequest | undefined {
  return db().snapshot().pullRequests.find((pr) => pr.key === step.prKey)
}

function namesFor(step: MergeStep): string[] {
  return savedPull(step)?.requiredCheckNames ?? []
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
  return mirrorPath(repo)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
