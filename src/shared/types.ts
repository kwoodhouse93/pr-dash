export type CiLevel = 'red' | 'yellow' | 'green' | 'pending' | 'none'

export type Check = {
  name: string
  status: string | null
  conclusion: string | null
  required: boolean
  url: string | null
  workflowName: string | null
  workflowRunId: number | null
  startedAt: string | null
  completedAt: string | null
  /** Required by the ruleset, but absent from the commit's check rollup. */
  unreported?: boolean
}

/** Head commit and combined check rollup. A later read can skip the full check list when this still matches. */
export type CheckRollup = {
  oid: string
  rollup: string | null
  count: number
}

/** Rollup from the last full check read, and when that read happened. */
export type CheckCursor = CheckRollup & {
  readAt: string
}

export type MergeMark = 'met' | 'unmet' | 'draft' | 'none'

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type Reviewer = {
  login: string
  avatarUrl?: string | null
  human: boolean
  state: 'APPROVED' | 'CHANGES_REQUESTED'
  submittedAt: string | null
}

export type LinearStatus = {
  id: string
  name: string
  type: string
  color: string
}

export type LinearAssignee = {
  id: string
  name: string
  avatarUrl: string | null
}

export type LinearIssue = {
  identifier: string
  title: string | null
  url: string | null
  projectId: string | null
  projectName: string | null
  teamId?: string | null
  status?: LinearStatus | null
  assignee?: LinearAssignee | null
}

export type PullRequest = {
  id: string
  key: string
  repo: string
  repoName: string
  number: number
  title: string
  url: string
  author: string
  authorAvatarUrl: string | null
  isDraft: boolean
  createdAt: string
  /** When review could start: the last time it left draft, or when it was opened. Null on a draft, missing on snapshots saved before this was read. */
  readyAt?: string | null
  updatedAt: string
  committedAt: string | null
  additions: number
  deletions: number
  changedFiles: number
  baseRef: string
  headRef: string
  defaultBranch: string
  squashMergeAllowed: boolean
  requiredApprovals: number
  dismissStale: boolean
  requiredCheckNames: string[]
  mergeable: Mergeable | null
  mergeStateStatus: string | null
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeMark: MergeMark
  mergeDetail: string
  anyApproval: boolean
  humanApproval: boolean
  changesRequested: boolean
  reviewers: Reviewer[]
  conflict: boolean
  behind: boolean
  checks: Check[]
  /** Set once checks have been read in full. Absent on snapshots saved before that. */
  checkCursor?: CheckCursor | null
  ci: CiLevel
  threadCount: number
  unresolvedCount: number
  awaitingYouCount: number
  unreadCount: number
  resolvedUnreadCount: number
  awaitingThreadUrl?: string | null
  unresolvedThreadUrl?: string | null
  unreadThreadUrl?: string | null
  resolvedUnreadThreadUrl?: string | null
  commentAwaitingCount: number
  reviewCommentAwaitingCount: number
  reviewPending: boolean
  threadsTruncated: boolean
  /** `updatedAt` the reply counts were loaded for. Missing means thread comments have not been read. */
  feedbackAt?: string | null
  linearIssues: LinearIssue[]
  initiativeIds: string[]
  /** Newest first. */
  agentSessions?: AgentSession[]
}

export type AgentSessionStatus = 'creating' | 'running' | 'waiting' | 'finished' | 'failed' | 'cancelled' | 'expired'

export type AgentKind = 'conflict' | 'ci' | 'prompt' | 'thread'

/** Where an agent runs. Each has a provider on the server. */
export type AgentProviderId = 'cursor' | 't3'

export type AgentSession = {
  provider: AgentProviderId
  agentId: string
  runId: string
  kind: AgentKind
  /** The user's text, or the file a review-thread fix was aimed at. */
  prompt: string | null
  status: AgentSessionStatus
  result: string | null
  branch: string | null
  /** The T3 Code environment the session runs in. Null is this machine, and every Cursor session. */
  environmentId: string | null
  /** The provider's page for the session, once it has one. */
  url: string | null
  /** When the provider stopped answering. While set, the status may be out of date. */
  unreachableSince: string | null
  createdAt: string
  updatedAt: string
}

/** Which provider starts agents: the default, and the repositories that use another. */
export type AgentRouting = {
  defaultProvider: AgentProviderId
  repos: Record<string, AgentProviderId>
}

export type RepoMark = { icon: string; color: string }

export type Initiative = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type Snapshot = {
  viewer: string | null
  syncedAt: string | null
  mineSyncedAt: string | null
  reviewSyncedAt: string | null
  /** Repositories a refresh is allowed to ask GitHub about. Empty until the user selects some. */
  repos: string[]
  /** Icon and colour the user picked for a repository. A repository without one gets a default from its name. */
  repoMarks?: Record<string, RepoMark>
  /** Absent on a snapshot from a server that only starts Cursor agents. */
  agents?: AgentRouting
  pullRequests: PullRequest[]
  reviewPullRequests: PullRequest[]
  initiatives: Initiative[]
  linearConfigured: boolean
  warning: string | null
}

export type SortKey = 'updated' | 'created' | 'size' | 'title' | 'repo' | 'ci'
export type SortDir = 'asc' | 'desc'
export type Sort = { key: SortKey; dir: SortDir }

export type Filters = {
  query: string
  repo: string | null
  hideDrafts: boolean
  ci: CiLevel | 'all'
  review: 'all' | 'unmet' | 'met' | 'human' | 'changes' | 'none'
  /** Whether the signed-in viewer's own approval should include or exclude a pull request. Only meaningful on the review tab. */
  approvedByMe: 'all' | 'only' | 'exclude'
  awaitingOnly: boolean
  initiativeId: string | null
}

export const DEFAULT_SORT: Sort = { key: 'updated', dir: 'desc' }

export const DEFAULT_FILTERS: Filters = {
  query: '',
  repo: null,
  hideDrafts: false,
  ci: 'all',
  review: 'all',
  approvedByMe: 'all',
  awaitingOnly: false,
  initiativeId: null,
}
