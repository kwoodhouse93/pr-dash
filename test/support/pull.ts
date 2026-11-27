import type { Check, PullRequest } from '../../src/shared/types.ts'

function check(): Check {
  return {
    name: 'Check',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    required: true,
    url: null,
    workflowName: null,
    workflowRunId: null,
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: '2026-10-20T12:05:00Z',
  }
}

/** An approved, passing pull request by ada in initech/frontend, with anything in `over` changed. */
export function pullRequest(number: number, over: Partial<PullRequest> = {}): PullRequest {
  const repoName = 'frontend'
  const repo = `initech/${repoName}`
  return {
    id: `pr-${number}`,
    key: `${repo}#${number}`,
    repo,
    repoName,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: 'ada',
    authorAvatarUrl: null,
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    committedAt: '2026-10-02T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    baseRef: 'main',
    headRef: `branch-${number}`,
    defaultBranch: 'main',
    squashMergeAllowed: true,
    requiredApprovals: 1,
    dismissStale: false,
    requiredCheckNames: ['Check'],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeMark: 'met',
    mergeDetail: '',
    anyApproval: true,
    humanApproval: true,
    changesRequested: false,
    reviewers: [],
    conflict: false,
    behind: false,
    checks: [check()],
    ci: 'green',
    threadCount: 0,
    unresolvedCount: 0,
    awaitingYouCount: 0,
    unreadCount: 0,
    resolvedUnreadCount: 0,
    commentAwaitingCount: 0,
    reviewCommentAwaitingCount: 0,
    reviewPending: false,
    threadsTruncated: false,
    linearIssues: [],
    initiativeIds: [],
    ...over,
  }
}
