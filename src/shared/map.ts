import { mergeReview, summarizeReviews, type ReviewDecision } from './approval.ts'
import { applyRequired, ciLevel, selectChecks } from './ci.ts'
import { summarizeNotes, summarizeThreads, type Note } from './feedback.ts'
import { parseLinear } from './linear.ts'
import type { Check, Mergeable, PullRequest } from './types.ts'

export type GitHubComment = {
  author: { __typename: string; login: string } | null
  body?: string
  createdAt?: string
}

export type GitHubPull = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  baseRefName: string
  headRefName: string
  reviewDecision: ReviewDecision
  mergeStateStatus: string | null
  mergeable: string | null
  author: { login: string; avatarUrl?: string | null } | null
  repository: {
    nameWithOwner: string
    name: string
    squashMergeAllowed: boolean
    defaultBranchRef: { name: string } | null
  }
  reviews: {
    nodes: Array<{
      state: string
      submittedAt: string | null
      body?: string | null
      author: { __typename: string; login: string } | null
    } | null> | null
  }
  reviewThreads: {
    pageInfo?: { hasNextPage: boolean }
    nodes: Array<{
      isResolved: boolean
      isOutdated: boolean
      resolvedBy?: { login: string } | null
      comments: { nodes: Array<GitHubComment | null> | null }
    } | null> | null
  }
  comments: { nodes: Array<GitHubComment | null> | null }
  latestComments?: { nodes: Array<GitHubComment | null> | null }
  reviewRequests?: {
    nodes: Array<{
      requestedReviewer: { __typename: string; login?: string | null; combinedSlug?: string | null } | null
    } | null> | null
  }
}

export type RawCheck = {
  __typename?: string
  name?: string
  context?: string
  conclusion?: string | null
  status?: string | null
  state?: string | null
  detailsUrl?: string | null
  targetUrl?: string | null
  startedAt?: string | null
  completedAt?: string | null
  createdAt?: string | null
  isRequired?: boolean | null
  checkSuite?: { workflowRun?: { databaseId?: number | null; workflow?: { name?: string | null } | null } | null } | null
}

function present<T>(value: T | null | undefined): value is T {
  return value != null
}

export function checksFromRaw(nodes: RawCheck[], requiredNames: string[]): Check[] {
  return selectChecks(applyRequired(nodes.map(mapRawCheck).filter(present), requiredNames))
}

function mapRawCheck(node: RawCheck): Check | null {
  if (node.__typename === 'StatusContext' || node.context) {
    const name = node.context
    if (!name) return null
    const pending = (node.state ?? '').toUpperCase() === 'PENDING'
    return {
      name,
      status: pending ? 'PENDING' : 'COMPLETED',
      conclusion: pending ? null : (node.state ?? null),
      required: false,
      url: node.targetUrl ?? null,
      workflowName: null,
      workflowRunId: null,
      startedAt: node.createdAt ?? null,
      completedAt: pending ? null : (node.createdAt ?? null),
    }
  }
  if (!node.name) return null
  return {
    name: node.name,
    status: node.status ?? null,
    conclusion: node.conclusion ?? null,
    required: node.isRequired === true,
    url: node.detailsUrl ?? null,
    workflowName: node.checkSuite?.workflowRun?.workflow?.name ?? null,
    workflowRunId: node.checkSuite?.workflowRun?.databaseId ?? null,
    startedAt: node.startedAt ?? null,
    completedAt: node.completedAt ?? null,
  }
}

export function mapPullRequest(
  node: GitHubPull,
  extras: {
    viewer: string
    teams?: string[]
    requiredNames: string[]
    requiredApprovals: number
    dismissStale: boolean
    committedAt: string | null
    checks: RawCheck[]
  },
): PullRequest {
  const reviews = summarizeReviews((node.reviews.nodes ?? []).filter(present))
  const threads = (node.reviewThreads.nodes ?? []).filter(present).map((thread) => ({
    isResolved: thread.isResolved,
    resolvedBy: thread.resolvedBy?.login ?? null,
    comments: (thread.comments.nodes ?? []).filter(present).map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt ?? '',
    })),
  }))
  const feedback = summarizeThreads(threads, extras.viewer)
  const notes = conversationNotes(node)
  const commentsAwaiting = summarizeNotes(threads, notes, extras.viewer)
  const comments = (node.comments.nodes ?? []).filter(present)
  const merge = mergeReview(node.reviewDecision, node.isDraft)
  const checks = checksFromRaw(extras.checks, extras.requiredNames)
  return {
    id: node.id,
    key: `${node.repository.nameWithOwner}#${node.number}`,
    repo: node.repository.nameWithOwner,
    repoName: node.repository.name,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? 'unknown',
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    committedAt: extras.committedAt,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    baseRef: node.baseRefName,
    headRef: node.headRefName,
    defaultBranch: node.repository.defaultBranchRef?.name ?? '',
    squashMergeAllowed: node.repository.squashMergeAllowed,
    requiredApprovals: extras.requiredApprovals,
    dismissStale: extras.dismissStale,
    requiredCheckNames: extras.requiredNames,
    mergeable: mergeableOf(node.mergeable),
    mergeStateStatus: node.mergeStateStatus,
    reviewDecision: node.reviewDecision,
    mergeMark: merge.mark,
    mergeDetail: merge.detail,
    anyApproval: reviews.anyApproval,
    humanApproval: reviews.humanApproval,
    changesRequested: reviews.changesRequested,
    reviewers: reviews.reviewers,
    conflict: node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY',
    behind: node.mergeStateStatus === 'BEHIND',
    checks,
    ci: ciLevel(checks),
    threadCount: feedback.threadCount,
    unresolvedCount: feedback.unresolvedCount,
    awaitingYouCount: feedback.awaitingYouCount,
    unreadCount: feedback.unreadCount,
    resolvedUnreadCount: feedback.resolvedUnreadCount,
    commentAwaitingCount: commentsAwaiting.author,
    reviewCommentAwaitingCount: commentsAwaiting.reviewer,
    reviewPending: reviewPending(node, extras.viewer, new Set(extras.teams ?? [])),
    threadsTruncated: node.reviewThreads.pageInfo?.hasNextPage === true,
    linearIssues: parseLinear({
      title: node.title,
      headRef: node.headRefName,
      comments: comments.map((comment) => ({ body: comment.body ?? '' })),
    }),
    initiativeIds: [],
  }
}

const SKIPPED_REVIEW = new Set(['PENDING', 'DISMISSED'])

function conversationNotes(node: GitHubPull): Note[] {
  const comments = (node.latestComments?.nodes ?? []).filter(present).map((comment) => ({
    author: comment.author,
    createdAt: comment.createdAt ?? '',
    body: comment.body ?? '',
    kind: 'comment' as const,
  }))
  const reviews = (node.reviews.nodes ?? []).filter(present).flatMap((review) => {
    if (SKIPPED_REVIEW.has(review.state)) return []
    return [{ author: review.author, createdAt: review.submittedAt ?? '', body: review.body ?? '', kind: 'review' as const }]
  })
  return [...comments, ...reviews]
}

function reviewPending(node: GitHubPull, viewer: string, teams: Set<string>): boolean {
  for (const request of node.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer
    if (!reviewer) continue
    if (reviewer.__typename === 'User' && reviewer.login === viewer) return true
    if (reviewer.__typename === 'Team' && reviewer.combinedSlug && teams.has(reviewer.combinedSlug)) return true
  }
  return false
}

function mergeableOf(value: string | null): Mergeable | null {
  if (value === 'MERGEABLE' || value === 'CONFLICTING' || value === 'UNKNOWN') return value
  return null
}
