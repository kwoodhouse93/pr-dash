import { mergeReview, summarizeReviews, type ReviewDecision } from './approval.ts'
import { applyRequired, checkPhase, ciLevel, selectChecks } from './ci.ts'
import { summarizeNotes, summarizeThreads, threadPermalink, type LocalResolutions, type Note, type Thread } from './feedback.ts'
import { parseLinear } from './linear.ts'
import type { Check, Mergeable, PullRequest } from './types.ts'

export type GitHubComment = {
  id?: string
  author: { __typename: string; login: string } | null
  body?: string
  createdAt?: string
  url?: string | null
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
      id?: string
      state: string
      submittedAt: string | null
      body?: string | null
      author: { __typename: string; login: string; avatarUrl?: string | null } | null
    } | null> | null
  }
  /** The last time the pull request left draft. Empty when it was opened ready. */
  readyEvents?: { nodes: Array<{ createdAt?: string | null } | null> | null } | null
  reviewThreads: {
    pageInfo?: { hasNextPage: boolean }
    nodes: Array<{
      isResolved: boolean
      isOutdated: boolean
      resolvedBy?: { login: string } | null
      comments?: { nodes: Array<GitHubComment | null> | null }
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

export type RawCheckSuite = {
  status?: string | null
  conclusion?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  url?: string | null
  workflowRun?: {
    databaseId?: number | null
    url?: string | null
    workflow?: { name?: string | null } | null
  } | null
  checkRuns?: { totalCount?: number | null } | null
}

const SUITE_FAILURE = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

export type CheckSource = {
  suites?: RawCheckSuite[]
  mergeStateStatus?: string | null
}

function present<T>(value: T | null | undefined): value is T {
  return value != null
}

export function checksFromRaw(nodes: RawCheck[], requiredNames: string[], source: CheckSource = {}): Check[] {
  const mapped = nodes.map(mapRawCheck).filter(present)
  const startup = workflowStartupChecks(source.suites ?? [])
  const selected = selectChecks(applyRequired([...mapped, ...startup], requiredNames))
  const seen = new Set(mapped.map((check) => check.name))
  const blocked = (source.mergeStateStatus ?? '').toUpperCase() === 'BLOCKED'
  const missing =
    blocked || startup.length > 0
      ? requiredNames.filter((name) => !seen.has(name)).map(unreportedCheck)
      : []
  return selectChecks([...selected, ...missing])
}

export type ShadowedRun = { runId: number; workflow: string }

/**
 * GitHub judges a workflow on a commit by the run it created last. A rebase and a base change
 * can start two runs at once, and the workflow's concurrency group sometimes cancels the newer
 * one. The older run then passes, and GitHub still counts the required check as cancelled.
 * Returns those cancelled runs once nothing in the workflow is still running.
 */
export function shadowedRuns(nodes: RawCheck[], requiredNames: string[]): ShadowedRun[] {
  const required = new Set(requiredNames)
  const workflows = new Map<string, Check[]>()
  for (const check of nodes.map(mapRawCheck).filter(present)) {
    if (!check.workflowName || check.workflowRunId == null) continue
    const list = workflows.get(check.workflowName) ?? []
    list.push(check)
    workflows.set(check.workflowName, list)
  }
  const shadowed: ShadowedRun[] = []
  for (const [workflow, checks] of workflows) {
    if (checks.some((check) => checkPhase(check) === 'pending')) continue
    const newest = Math.max(...checks.map((check) => check.workflowRunId ?? 0))
    const cancelled = checks.some(
      (check) => check.workflowRunId === newest && (check.conclusion ?? '').toUpperCase() === 'CANCELLED',
    )
    const passedEarlier = checks.some(
      (check) => check.workflowRunId !== newest && required.has(check.name) && checkPhase(check) === 'success',
    )
    if (cancelled && passedEarlier) shadowed.push({ runId: newest, workflow })
  }
  return shadowed
}

/**
 * A GitHub Actions workflow that fails before creating jobs never appears in the check rollup.
 * Keep the latest suite per workflow. A later suite that created jobs replaces the failure.
 */
export function workflowStartupChecks(suites: RawCheckSuite[]): Check[] {
  const latest = new Map<string, RawCheckSuite>()
  for (const suite of suites) {
    const workflow = suite.workflowRun?.workflow?.name
    if (!workflow) continue
    const current = latest.get(workflow)
    if (!current || suiteTime(suite) >= suiteTime(current)) latest.set(workflow, suite)
  }
  const checks: Check[] = []
  for (const [workflow, suite] of latest) {
    const runs = suite.checkRuns?.totalCount
    const conclusion = (suite.conclusion ?? '').toUpperCase()
    if (runs == null || runs > 0 || !SUITE_FAILURE.has(conclusion)) continue
    checks.push({
      name: `${workflow} — workflow startup`,
      status: suite.status ?? 'COMPLETED',
      conclusion,
      required: true,
      url: suite.workflowRun?.url ?? suite.url ?? null,
      workflowName: workflow,
      workflowRunId: suite.workflowRun?.databaseId ?? null,
      startedAt: suite.createdAt ?? null,
      completedAt: suite.updatedAt ?? null,
    })
  }
  return checks
}

function suiteTime(suite: RawCheckSuite): number {
  const raw = suite.updatedAt ?? suite.createdAt
  const time = raw ? Date.parse(raw) : 0
  return Number.isNaN(time) ? 0 : time
}

function unreportedCheck(name: string): Check {
  return {
    name,
    status: 'COMPLETED',
    conclusion: null,
    required: true,
    url: null,
    workflowName: null,
    workflowRunId: null,
    startedAt: null,
    completedAt: null,
    unreported: true,
  }
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

/**
 * GitHub's Update branch button follows commits on the base that are missing from the head.
 * `mergeStateStatus` is `BEHIND` only when that is the sole merge blocker, so a `BLOCKED`
 * pull request can still be behind. `behindBy` is null when that comparison was not loaded.
 */
export function isBehindBase(mergeStateStatus: string | null, behindBy: number | null | undefined): boolean {
  if (typeof behindBy === 'number') return behindBy > 0
  return mergeStateStatus === 'BEHIND'
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
    suites?: RawCheckSuite[]
    behindBy?: number | null
    /** What the viewer resolved on this dashboard only. */
    local?: LocalResolutions
  },
): PullRequest {
  const reviews = summarizeReviews((node.reviews.nodes ?? []).filter(present))
  const threadNodes = (node.reviewThreads.nodes ?? []).filter(present)
  const commentsLoaded = threadNodes.every((thread) => thread.comments !== undefined)
  const detail = feedbackFrom(threadNodes, node, extras.viewer, extras.local)
  const comments = (node.comments.nodes ?? []).filter(present)
  const merge = mergeReview(node.reviewDecision, node.isDraft)
  const checks = checksFromRaw(extras.checks, extras.requiredNames, {
    suites: extras.suites,
    mergeStateStatus: node.mergeStateStatus,
  })
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
    readyAt: node.isDraft ? null : (node.readyEvents?.nodes?.find(present)?.createdAt ?? node.createdAt),
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
    viewerReviewedAt: lastReviewBy((node.reviews.nodes ?? []).filter(present), extras.viewer),
    conflict: node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY',
    behind: isBehindBase(node.mergeStateStatus, extras.behindBy),
    checks,
    ci: ciLevel(checks),
    threadCount: detail.feedback.threadCount,
    unresolvedCount: detail.feedback.unresolvedCount,
    awaitingYouCount: detail.feedback.awaitingYouCount,
    unreadCount: detail.feedback.unreadCount,
    resolvedUnreadCount: detail.feedback.resolvedUnreadCount,
    awaitingThreadUrl: detail.feedback.awaitingUrl,
    unresolvedThreadUrl: detail.feedback.unresolvedUrl,
    unreadThreadUrl: detail.feedback.unreadUrl,
    resolvedUnreadThreadUrl: detail.feedback.resolvedUnreadUrl,
    commentAwaitingCount: detail.commentsAwaiting.author,
    reviewCommentAwaitingCount: detail.commentsAwaiting.reviewer,
    reviewPending: reviewPending(node, extras.viewer, new Set(extras.teams ?? [])),
    threadsTruncated: node.reviewThreads.pageInfo?.hasNextPage === true,
    feedbackAt: commentsLoaded ? node.updatedAt : null,
    linearIssues: parseLinear({
      title: node.title,
      headRef: node.headRefName,
      comments: comments.map((comment) => ({ body: comment.body ?? '' })),
    }),
    initiativeIds: [],
  }
}

const SKIPPED_REVIEW = new Set(['PENDING', 'DISMISSED'])

export type ThreadDetail = {
  updatedAt: string
  reviews: GitHubPull['reviews']
  reviewThreads: GitHubPull['reviewThreads']
  latestComments?: GitHubPull['latestComments']
}

export function applyThreadDetails(pr: PullRequest, detail: ThreadDetail, viewer: string, local: LocalResolutions = {}): PullRequest {
  const at = Date.parse(detail.updatedAt)
  const current = Date.parse(pr.updatedAt)
  if (Number.isFinite(at) && Number.isFinite(current) && at < current) return pr
  const threads = threadsFrom(detail.reviewThreads.nodes)
  const feedback = summarizeThreads(threads, viewer)
  const commentsAwaiting = summarizeNotes(threads, conversationNotes(detail), viewer, local)
  return {
    ...pr,
    updatedAt: Number.isFinite(at) && (!Number.isFinite(current) || at > current) ? detail.updatedAt : pr.updatedAt,
    threadCount: feedback.threadCount,
    unresolvedCount: feedback.unresolvedCount,
    awaitingYouCount: feedback.awaitingYouCount,
    unreadCount: feedback.unreadCount,
    resolvedUnreadCount: feedback.resolvedUnreadCount,
    awaitingThreadUrl: feedback.awaitingUrl,
    unresolvedThreadUrl: feedback.unresolvedUrl,
    unreadThreadUrl: feedback.unreadUrl,
    resolvedUnreadThreadUrl: feedback.resolvedUnreadUrl,
    commentAwaitingCount: commentsAwaiting.author,
    reviewCommentAwaitingCount: commentsAwaiting.reviewer,
    threadsTruncated: detail.reviewThreads.pageInfo?.hasNextPage === true,
    feedbackAt: detail.updatedAt,
  }
}

function feedbackFrom(
  threadNodes: Array<{
    isResolved: boolean
    resolvedBy?: { login: string } | null
    comments?: { nodes: Array<GitHubComment | null> | null }
  }>,
  node: GitHubPull,
  viewer: string,
  local: LocalResolutions = {},
) {
  const threads = threadsFrom(threadNodes)
  return {
    feedback: summarizeThreads(threads, viewer),
    commentsAwaiting: summarizeNotes(threads, conversationNotes(node), viewer, local),
  }
}

function threadsFrom(
  nodes:
    | Array<{
        isResolved: boolean
        resolvedBy?: { login: string } | null
        comments?: { nodes: Array<GitHubComment | null> | null }
      } | null>
    | null
    | undefined,
): Thread[] {
  return (nodes ?? []).filter(present).map((thread) => {
    const comments = (thread.comments?.nodes ?? []).filter(present)
    return {
      isResolved: thread.isResolved,
      resolvedBy: thread.resolvedBy?.login ?? null,
      url: threadPermalink(comments),
      comments: comments.map((comment) => ({
        author: comment.author,
        createdAt: comment.createdAt ?? '',
      })),
    }
  })
}

/** The latest review the viewer submitted, of any kind. One still being written does not count. */
function lastReviewBy(reviews: { state: string; submittedAt: string | null; author: { login: string } | null }[], viewer: string): string | null {
  const login = viewer.toLowerCase()
  if (!login) return null
  const times = reviews.filter((review) => review.state !== 'PENDING' && review.submittedAt && review.author?.login.toLowerCase() === login).map((review) => review.submittedAt!)
  return times.sort().at(-1) ?? null
}

function conversationNotes(node: { latestComments?: GitHubPull['latestComments']; reviews: GitHubPull['reviews'] }): Note[] {
  const comments = (node.latestComments?.nodes ?? []).filter(present).map((comment) => ({
    id: comment.id ?? null,
    author: comment.author,
    createdAt: comment.createdAt ?? '',
    body: comment.body ?? '',
    kind: 'comment' as const,
  }))
  const reviews = (node.reviews.nodes ?? []).filter(present).flatMap((review) => {
    if (SKIPPED_REVIEW.has(review.state)) return []
    return [{ id: review.id ?? null, author: review.author, createdAt: review.submittedAt ?? '', body: review.body ?? '', kind: 'review' as const }]
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
