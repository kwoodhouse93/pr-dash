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

export type MergeMark = 'met' | 'unmet' | 'draft' | 'none'

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type Reviewer = {
  login: string
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
  cursorSession?: CursorSession | null
}

export type CursorSessionStatus = 'creating' | 'running' | 'finished' | 'failed' | 'cancelled' | 'expired'

export type CursorSession = {
  agentId: string
  runId: string
  status: CursorSessionStatus
  result: string | null
  branch: string | null
  updatedAt: string
}

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
  awaitingOnly: false,
  initiativeId: null,
}
