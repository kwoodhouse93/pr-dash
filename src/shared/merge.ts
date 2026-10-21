import { checkPhase } from './ci.ts'
import type { PullRequest } from './types.ts'

const READY: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

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
): { action: 'fail' | 'wait'; names: string[] } | null {
  const failing: string[] = []
  const waiting: string[] = []
  const missing: string[] = []
  for (const name of requiredNames) {
    const check = checks.find((item) => item.name === name)
    if (!check) missing.push(name)
    else if (checkPhase(check) === 'fail') failing.push(name)
    else if (checkPhase(check) !== 'success') waiting.push(name)
  }
  if (failing.length > 0) return { action: 'fail', names: failing }
  if (waiting.length > 0) return { action: 'wait', names: waiting }
  const extraFailing = checks.filter((check) => check.required && !requiredNames.includes(check.name) && checkPhase(check) === 'fail')
  if (extraFailing.length > 0) return { action: 'fail', names: extraFailing.map((check) => check.name) }
  const extraWaiting = checks.filter((check) => check.required && !requiredNames.includes(check.name) && checkPhase(check) !== 'success')
  if (extraWaiting.length > 0) return { action: 'wait', names: extraWaiting.map((check) => check.name) }
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
    pr.unresolvedCount === 0
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

export function upstackBlock(pr: PullRequest, bar: ReviewBar): string | null {
  if (!pr.squashMergeAllowed) return `Squash merge is disabled for ${pr.repoName}.`
  if (pr.isDraft) return `#${pr.number} is still a draft.`
  if (pr.conflict) return `#${pr.number} has a merge conflict.`
  if (pr.behind) return `#${pr.number} is behind its base branch.`
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
