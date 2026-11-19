import type { MergeMark, PullRequest, Reviewer } from './types.ts'

/** True when `login` is a person whose latest review on the pull request is an approval. */
export function approvedByLogin(pr: Pick<PullRequest, 'reviewers'>, login: string | null): boolean {
  if (!login) return false
  return pr.reviewers.some((reviewer) => reviewer.human && reviewer.login === login && reviewer.state === 'APPROVED')
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

type RawReview = {
  state: string
  submittedAt: string | null
  author: { __typename: string; login: string; avatarUrl?: string | null } | null
}

export function mergeReview(decision: ReviewDecision, isDraft: boolean): { mark: MergeMark; detail: string } {
  if (isDraft) {
    return {
      mark: 'draft',
      detail: 'Draft. GitHub is not applying review requirements yet.',
    }
  }
  if (decision === 'APPROVED') {
    return {
      mark: 'met',
      detail: 'Review requirements are met, including code owner and team rules when GitHub applies them.',
    }
  }
  if (decision === 'CHANGES_REQUESTED') {
    return { mark: 'unmet', detail: 'Changes have been requested.' }
  }
  if (decision === 'REVIEW_REQUIRED') {
    return {
      mark: 'unmet',
      detail: 'Required reviews are still missing. This includes code owners when that rule applies.',
    }
  }
  return {
    mark: 'none',
    detail:
      'No review requirement applies to this pull request. On a stack, GitHub often only requires review on the pull request that targets the default branch.',
  }
}

export function summarizeReviews(reviews: RawReview[]): {
  anyApproval: boolean
  humanApproval: boolean
  changesRequested: boolean
  reviewers: Reviewer[]
} {
  const latest = new Map<string, RawReview>()
  const ordered = reviews
    .filter((review) => review.author?.login)
    .filter((review) => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
    .slice()
    .sort((a, b) => Date.parse(a.submittedAt ?? '') - Date.parse(b.submittedAt ?? ''))
  for (const review of ordered) {
    latest.set(review.author!.login, review)
  }
  const reviewers: Reviewer[] = [...latest.values()]
    .map((review) => ({
      login: review.author!.login,
      avatarUrl: review.author!.avatarUrl ?? null,
      human: review.author!.__typename === 'User',
      state: review.state as Reviewer['state'],
      submittedAt: review.submittedAt,
    }))
    .sort((a, b) => Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? ''))
  return {
    anyApproval: reviewers.some((reviewer) => reviewer.state === 'APPROVED'),
    humanApproval: reviewers.some((reviewer) => reviewer.human && reviewer.state === 'APPROVED'),
    changesRequested: reviewers.some((reviewer) => reviewer.state === 'CHANGES_REQUESTED'),
    reviewers,
  }
}
