import { approvedByLogin } from './approval.ts'
import { canMergeSlice, canSquashMerge } from './merge.ts'
import type { PullRequest } from './types.ts'
import { needsAttention } from './view.ts'

/** Where one pull request stands, worst first: broken, waiting on you, draft, ready, or waiting on someone else. */
export type SegmentState = 'broken' | 'you' | 'draft' | 'ready' | 'waiting'

/**
 * `orderedTopToBottom` is the whole stack, so readiness can look at what sits below.
 * On My PRs, ready means the Merge button would show. On Review, it means you approved.
 */
export function segmentState(
  pr: PullRequest,
  orderedTopToBottom: PullRequest[],
  mode: 'mine' | 'review',
  viewer: string | null,
): SegmentState {
  if (pr.conflict || pr.ci === 'red') return 'broken'
  if (mode === 'review') {
    if (pr.reviewPending || needsAttention(pr, 'reviewer')) return 'you'
    if (pr.isDraft) return 'draft'
    return approvedByLogin(pr, viewer) ? 'ready' : 'waiting'
  }
  if (needsAttention(pr, 'author')) return 'you'
  if (pr.isDraft) return 'draft'
  if (canSquashMerge(pr) || canMergeSlice(orderedTopToBottom, pr.key) != null) return 'ready'
  return 'waiting'
}

export type Rollup = { ready: number; you: number; broken: number }

export function rollup(states: SegmentState[]): Rollup {
  const count = (state: SegmentState) => states.filter((item) => item === state).length
  return { ready: count('ready'), you: count('you'), broken: count('broken') }
}

export const SEGMENT_LABEL: Record<'mine' | 'review', Record<SegmentState, string>> = {
  mine: { broken: 'conflict or failing CI', you: 'needs you', draft: 'draft', ready: 'ready to merge', waiting: 'waiting' },
  review: { broken: 'conflict or failing CI', you: 'needs you', draft: 'draft', ready: 'approved by you', waiting: 'waiting' },
}
