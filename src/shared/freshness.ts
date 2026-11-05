import { checkPhase, ciLevel, selectChecks } from './ci.ts'
import type { Check, CheckCursor, CheckRollup, PullRequest } from './types.ts'

/** Settled pull requests reread in one refresh. The least recently read go first, so a quiet rerun cycles through. */
export const CHECK_SWEEP_BATCH = 8

/**
 * Age before a settled pull request joins that sweep.
 * Zero means every refresh rereads the oldest batch, which keeps a rerun from waiting out a long timer.
 */
export const CHECK_SWEEP_AFTER_MS = 0

function checkStillRunning(check: Check): boolean {
  const phase = checkPhase(check)
  return phase === 'pending' || phase === 'missing'
}

/**
 * Running required checks, or any running check when nothing is required.
 * An optional check that is still going does not change a row whose required checks have settled,
 * and some of those (Graphite's mergeability check) stay in progress indefinitely.
 */
export function checksInFlight(checks: Check[]): boolean {
  const selected = selectChecks(checks)
  const required = selected.filter((check) => check.required)
  if (required.some(checkStillRunning)) return true
  if (required.length === 0 && selected.some(checkStillRunning)) return true
  return false
}

/**
 * A full check list is required when this pull request is new, moved, still running,
 * or has never had its checks stored. Settled rows can be compared with a cheap rollup first.
 */
export function needsFreshChecks(previous: PullRequest | undefined, updatedAt: string): boolean {
  if (!previous?.checkCursor) return true
  if (previous.updatedAt !== updatedAt) return true
  if (checksInFlight(previous.checks)) return true
  if (previous.requiredCheckNames.length > 0 && selectChecks(previous.checks).length === 0) return true
  return false
}

export function cursorsMatch(stored: CheckCursor | null | undefined, seen: CheckRollup | null | undefined): boolean {
  if (!stored || !seen) return false
  return stored.oid === seen.oid && stored.rollup === seen.rollup && stored.count === seen.count
}

/**
 * `behindBy` is the expensive comparison. Skip it when the pull request and GitHub's merge
 * state are unchanged. A blocked pull request that was up to date can fall behind without
 * that state changing, so those stay in the fetch.
 */
export function needsFreshBehind(
  previous: PullRequest | undefined,
  next: { updatedAt: string; mergeStateStatus: string | null; mergeable: string | null },
): boolean {
  if (!previous) return true
  if (previous.updatedAt !== next.updatedAt) return true
  if ((previous.mergeStateStatus ?? null) !== (next.mergeStateStatus ?? null)) return true
  if ((previous.mergeable ?? null) !== (next.mergeable ?? null)) return true
  const status = next.mergeStateStatus
  if (status == null || status === 'UNKNOWN' || status === 'BEHIND') return true
  if (status === 'BLOCKED' && !previous.behind) return true
  return false
}

export type CheckReadPlan = {
  fetch: string[]
  probe: string[]
}

export function planCheckReads(
  nodes: { id: string; updatedAt: string }[],
  previous: Map<string, PullRequest>,
  force: boolean,
): CheckReadPlan {
  const fetch: string[] = []
  const probe: string[] = []
  for (const node of nodes) {
    if (force || needsFreshChecks(previous.get(node.id), node.updatedAt)) fetch.push(node.id)
    else probe.push(node.id)
  }
  return { fetch, probe }
}

/** Probe matches that are due for a full reread, oldest first, capped at one batch. */
export function picksForSweep(
  matched: { id: string; readAt: string }[],
  now: number,
  batch = CHECK_SWEEP_BATCH,
  maxAge = CHECK_SWEEP_AFTER_MS,
): Set<string> {
  const due = matched
    .map((item) => ({ id: item.id, at: Date.parse(item.readAt) }))
    .filter((item) => !Number.isFinite(item.at) || now - item.at >= maxAge)
    .sort((left, right) => left.at - right.at)
  return new Set(due.slice(0, batch).map((item) => item.id))
}

export function readsAfterProbe(
  probeIds: string[],
  previous: Map<string, PullRequest>,
  seen: Map<string, CheckRollup | null>,
  now: number,
): { fetch: string[]; reuse: string[] } {
  const fetch: string[] = []
  const matched: { id: string; readAt: string }[] = []
  for (const id of probeIds) {
    const prior = previous.get(id)
    if (!prior?.checkCursor || !cursorsMatch(prior.checkCursor, seen.get(id) ?? null)) {
      fetch.push(id)
      continue
    }
    matched.push({ id, readAt: prior.checkCursor.readAt })
  }
  const sweep = picksForSweep(matched, now)
  const reuse: string[] = []
  for (const item of matched) {
    if (sweep.has(item.id)) fetch.push(item.id)
    else reuse.push(item.id)
  }
  return { fetch, reuse }
}

/** Keep the stored check list and apply required names learned on this refresh. */
export function reuseChecks(previous: PullRequest, requiredNames: string[]): Pick<PullRequest, 'checks' | 'ci' | 'committedAt' | 'checkCursor'> {
  const names = new Set(requiredNames)
  const checks = previous.checks.map((check) => ({
    ...check,
    required: names.has(check.name) || check.required,
  }))
  return {
    checks,
    ci: ciLevel(checks),
    committedAt: previous.committedAt,
    checkCursor: previous.checkCursor,
  }
}
