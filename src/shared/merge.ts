import { checkPhase } from './ci.ts'
import type { PullRequest } from './types.ts'

const READY: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

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
    pr.mergeable === 'MERGEABLE' &&
    READY.has(pr.mergeStateStatus ?? '') &&
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
  const names = pr.requiredCheckNames ?? []
  for (const name of names) {
    const check = pr.checks.find((item) => item.name === name)
    if (!check || checkPhase(check) !== 'success') return `#${pr.number} is waiting on required checks.`
  }
  if (pr.ci === 'red') return `#${pr.number} has a required check failing.`
  if (pr.checks.some((check) => check.required && checkPhase(check) !== 'success')) {
    return `#${pr.number} is waiting on required checks.`
  }
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
