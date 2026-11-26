import { checkPhase } from './ci.ts'
import type { PullRequest } from './types.ts'

const READY: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

function cancelledCheck(check: { conclusion: string | null }): boolean {
  return (check.conclusion ?? '').toUpperCase() === 'CANCELLED'
}

export function mergeStateReady(mergeable: string | null, mergeStateStatus: string | null): boolean {
  return mergeable === 'MERGEABLE' && READY.has(mergeStateStatus ?? '')
}

/**
 * Required checks that have reported must pass.
 * A ruleset check that never reported does not block once GitHub already calls the pull request mergeable
 * and some other check has reported. An empty rollup still waits, so a merge does not race CI startup.
 */
export function requiredCheckGate(
  checks: PullRequest['checks'],
  requiredNames: string[],
  mergeable: string | null,
  mergeStateStatus: string | null,
): { action: 'fail' | 'wait'; names: string[]; restarting?: boolean } | null {
  const failing: string[] = []
  const waiting: string[] = []
  const cancelled: string[] = []
  const missing: string[] = []
  for (const name of requiredNames) {
    const check = checks.find((item) => item.name === name)
    if (!check || check.unreported) missing.push(name)
    else if (cancelledCheck(check)) cancelled.push(name)
    else if (checkPhase(check) === 'fail') failing.push(name)
    else if (checkPhase(check) !== 'success') waiting.push(name)
  }
  const extras = checks.filter((check) => check.required && !requiredNames.includes(check.name))
  for (const check of extras) {
    if (cancelledCheck(check)) cancelled.push(check.name)
    else if (checkPhase(check) === 'fail') failing.push(check.name)
    else if (checkPhase(check) !== 'success') waiting.push(check.name)
  }
  if (failing.length > 0) return { action: 'fail', names: failing }
  if (waiting.length > 0) return { action: 'wait', names: waiting }
  if (cancelled.length > 0) return { action: 'wait', names: cancelled, restarting: true }
  if (missing.length > 0 && (checks.length === 0 || !mergeStateReady(mergeable, mergeStateStatus))) {
    return { action: 'wait', names: missing }
  }
  return null
}

export type ReviewBar = {
  requiredApprovals: number
  dismissStale: boolean
}

export function canSquashMerge(pr: PullRequest): boolean {
  return (
    pr.squashMergeAllowed === true &&
    typeof pr.defaultBranch === 'string' &&
    pr.defaultBranch.length > 0 &&
    pr.baseRef === pr.defaultBranch &&
    !pr.isDraft &&
    mergeStateReady(pr.mergeable, pr.mergeStateStatus) &&
    pr.unresolvedCount === 0 &&
    requiredCheckGate(pr.checks, pr.requiredCheckNames ?? [], pr.mergeable, pr.mergeStateStatus)?.action !== 'fail'
  )
}

/** What an upstack pull request will need once it targets the default branch. */
export function stackReviewBar(bottom: PullRequest): ReviewBar {
  const fromRules = bottom.requiredApprovals ?? 0
  const trunkReviews = bottom.mergeMark === 'met' || bottom.mergeMark === 'unmet'
  return {
    requiredApprovals: Math.max(fromRules, trunkReviews ? 1 : 0),
    dismissStale: bottom.dismissStale === true,
  }
}

/**
 * Whether an upstack pull request is ready to go into a downstack merge. Being behind its base does not block:
 * the queue rebases each branch onto the trunk once the one below it merges.
 */
export function upstackBlock(pr: PullRequest, bar: ReviewBar): string | null {
  if (!pr.squashMergeAllowed) return `Squash merge is disabled for ${pr.repoName}.`
  if (pr.isDraft) return `#${pr.number} is still a draft.`
  if (pr.conflict) return `#${pr.number} has a merge conflict.`
  if (pr.mergeable !== 'MERGEABLE') return `#${pr.number} is not mergeable yet.`
  if (pr.unresolvedCount > 0) return `#${pr.number} has unresolved threads.`
  if (pr.threadsTruncated) return `#${pr.number} has more review threads than this list loaded.`
  if (pr.changesRequested) return `#${pr.number} has changes requested.`
  const approved = pr.reviewers.filter((reviewer) => reviewer.state === 'APPROVED')
  if (bar.dismissStale && bar.requiredApprovals > 0) {
    const commitAt = pr.committedAt ? Date.parse(pr.committedAt) : Number.NaN
    const fresh = approved.filter((reviewer) => Date.parse(reviewer.submittedAt ?? '') >= commitAt)
    if (!Number.isFinite(commitAt) || fresh.length < bar.requiredApprovals) {
      return `#${pr.number} needs a fresh approval after the latest commit.`
    }
  } else if (approved.length < bar.requiredApprovals) {
    return `#${pr.number} is missing a required approval.`
  }
  const gate = requiredCheckGate(pr.checks, pr.requiredCheckNames ?? [], pr.mergeable, pr.mergeStateStatus)
  if (gate?.action === 'fail') return `#${pr.number} has a required check failing: ${gate.names.join(', ')}.`
  if (gate?.action === 'wait') return `#${pr.number} is waiting on required checks: ${gate.names.join(', ')}.`
  return null
}

/**
 * Why a pull request cannot merge without its required approval, or null when the approval is the
 * only thing missing. GitHub reports such a pull request as blocked, so this reads the queue's own gates.
 */
export function unapprovedMergeBlock(pr: PullRequest): string | null {
  if (pr.baseRef !== pr.defaultBranch) return `#${pr.number} does not target ${pr.defaultBranch}.`
  if (pr.reviewDecision !== 'REVIEW_REQUIRED') return `#${pr.number} is not waiting on an approval.`
  return upstackBlock(pr, { requiredApprovals: 0, dismissStale: false })
}

export function predictedReady(pr: PullRequest, bar: ReviewBar): boolean {
  return upstackBlock(pr, bar) === null
}

/** Pull requests from the clicked one down to trunk, when each of them looks mergeable. */
export function canMergeSlice(orderedTopToBottom: PullRequest[], key: string): number | null {
  const index = orderedTopToBottom.findIndex((pr) => pr.key === key)
  if (index < 0 || index === orderedTopToBottom.length - 1) return null
  const slice = orderedTopToBottom.slice(index)
  const bottom = slice[slice.length - 1]!
  if (bottom.baseRef !== bottom.defaultBranch || !canSquashMerge(bottom)) return null
  const bar = stackReviewBar(bottom)
  for (const pr of slice.slice(0, -1)) {
    if (!predictedReady(pr, bar)) return null
  }
  return slice.length
}

export function sliceParts(
  orderedTopToBottom: PullRequest[],
  key: string,
): { merge: PullRequest[]; restack: PullRequest[] } | null {
  const index = orderedTopToBottom.findIndex((pr) => pr.key === key)
  if (index < 0 || index === orderedTopToBottom.length - 1) return null
  return {
    restack: orderedTopToBottom.slice(0, index),
    merge: orderedTopToBottom.slice(index),
  }
}
