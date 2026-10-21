import { describe, expect, it } from 'vitest'
import { mergeReview, summarizeReviews } from '../src/shared/approval.ts'
import { canSquashMerge } from '../src/shared/merge.ts'
import {
  activeHoldNames,
  applyRequired,
  ciLabel,
  ciLevel,
  compareChecks,
  displayCi,
  holdsFor,
  mergeHolds,
  reconcileHolds,
  selectChecks,
  withoutHolds,
} from '../src/shared/ci.ts'
import { feedbackCounts, quoteReply, summarizeNotes, summarizeThreads, threadKinds, threadPermalink } from '../src/shared/feedback.ts'
import { reviewSearchQueries } from '../src/server/github.ts'
import { parseLinear } from '../src/shared/linear.ts'
import { requiredCheckNames } from '../src/shared/rules.ts'
import { buildStacks, restackChain, summarize } from '../src/shared/stacks.ts'
import type { Check, PullRequest } from '../src/shared/types.ts'
import { buildOutline } from '../src/shared/view.ts'
import { DEFAULT_FILTERS, DEFAULT_SORT } from '../src/shared/types.ts'

function check(over: Partial<Check> & Pick<Check, 'name' | 'conclusion'>): Check {
  return {
    status: 'COMPLETED',
    required: false,
    url: null,
    workflowName: null,
    workflowRunId: null,
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: '2026-10-20T12:05:00Z',
    ...over,
  }
}

describe('ci', () => {
  it('is red when a required check failed', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: 'FAILURE', required: true }),
      check({ name: 'Lint', conclusion: 'SUCCESS', required: false }),
    ])
    expect(level).toBe('red')
  })

  it('is yellow when required checks passed and an optional check failed', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: 'SUCCESS', required: true }),
      check({ name: 'Generate and Diff', conclusion: 'FAILURE', required: false }),
    ])
    expect(level).toBe('yellow')
  })

  it('treats a failure as optional when no check is required', () => {
    expect(ciLevel([check({ name: 'Check', conclusion: 'FAILURE' })])).toBe('yellow')
  })

  it('prefers yellow over pending when an optional check already failed', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: null, status: 'IN_PROGRESS', required: true, completedAt: null }),
      check({ name: 'Preview', conclusion: 'FAILURE' }),
    ])
    expect(level).toBe('yellow')
  })

  it('is pending while a required check runs and nothing has failed', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: null, status: 'IN_PROGRESS', required: true, completedAt: null }),
    ])
    expect(level).toBe('pending')
  })

  it('stays green when required checks passed and an optional check is still running', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: 'SUCCESS', required: true }),
      check({ name: 'Graphite / mergeability_check', conclusion: null, status: 'IN_PROGRESS', completedAt: null }),
    ])
    expect(level).toBe('green')
  })

  it('is green when every check passed and ignores skips', () => {
    const level = ciLevel([
      check({ name: 'Check', conclusion: 'SUCCESS', required: true }),
      check({ name: 'claude-write', conclusion: 'SKIPPED' }),
    ])
    expect(level).toBe('green')
  })

  it('is none when every check was skipped', () => {
    expect(ciLevel([check({ name: 'claude-write', conclusion: 'SKIPPED' })])).toBe('none')
  })

  it('follows a newer run when an earlier one was cancelled', () => {
    const selected = selectChecks([
      check({ name: 'Run', conclusion: 'CANCELLED', completedAt: '2026-10-21T09:25:36Z', required: true }),
      check({ name: 'Run', conclusion: null, status: 'IN_PROGRESS', startedAt: '2026-10-21T09:25:50Z', completedAt: null, required: true }),
    ])
    expect(selected).toHaveLength(1)
    expect(selected[0]?.status).toBe('IN_PROGRESS')
    expect(ciLevel(selected)).toBe('pending')
  })

  it('keeps the latest run of a check name', () => {
    const selected = selectChecks([
      check({ name: 'Check', conclusion: 'FAILURE', completedAt: '2026-10-20T10:00:00Z' }),
      check({ name: 'Check', conclusion: 'SUCCESS', completedAt: '2026-10-20T12:00:00Z', required: true }),
    ])
    expect(selected).toHaveLength(1)
    expect(selected[0]?.conclusion).toBe('SUCCESS')
    expect(ciLevel(selected)).toBe('green')
  })

  it('orders failing checks ahead of passing ones', () => {
    const checks = [
      check({ name: 'Scan', conclusion: 'SUCCESS' }),
      check({ name: 'Run', conclusion: 'FAILURE', required: true, workflowName: 'E2E Tests (Staging)' }),
      check({ name: 'Unit (1/2)', conclusion: 'FAILURE', workflowName: 'Vitest Tests' }),
      check({ name: 'Check', conclusion: 'SUCCESS', required: true, workflowName: 'Lint & Types' }),
    ]
    expect([...checks].sort(compareChecks).map((item) => item.name)).toEqual(['Run', 'Unit (1/2)', 'Check', 'Scan'])
  })

  it('hides a rerun until a refresh reports a different run', () => {
    const failed = check({ name: 'Check', conclusion: 'FAILURE', required: true, workflowRunId: 7 })
    const holds = holdsFor([failed], 'failed', null, 'acme/app')
    expect(displayCi([failed], activeHoldNames([failed], holds))).toBe('invalidated')
    expect(ciLabel('invalidated')).toBe('Invalidated')

    const stale = check({ name: 'Check', conclusion: 'FAILURE', required: true, workflowRunId: 7 })
    expect(reconcileHolds(holds, [stale])).toEqual(holds)

    const running = check({
      name: 'Check',
      conclusion: null,
      status: 'IN_PROGRESS',
      required: true,
      workflowRunId: 7,
      completedAt: null,
      startedAt: '2026-10-21T09:25:50Z',
    })
    expect(reconcileHolds(holds, [running])).toEqual([])
    expect(displayCi([running], activeHoldNames([running], holds))).toBe('pending')
  })

  it('keeps a failure that the rerun did not touch', () => {
    const checks = [
      check({ name: 'Check', conclusion: 'FAILURE', required: true, workflowRunId: 7 }),
      check({ name: 'Lint', conclusion: 'FAILURE', required: true }),
    ]
    const holds = holdsFor(checks, 'failed', null, 'acme/app')
    expect(holds.map((hold) => hold.name)).toEqual(['Check'])
    expect(displayCi(checks, activeHoldNames(checks, holds))).toBe('red')
  })

  it('reruns failed workflow checks, and every workflow check when rerunning all', () => {
    const checks = [
      check({ name: 'Check', conclusion: 'SUCCESS', required: true, workflowRunId: 7 }),
      check({ name: 'Preview', conclusion: 'FAILURE', workflowRunId: 8 }),
    ]
    expect(holdsFor(checks, 'failed', null, 'acme/app').map((hold) => hold.name)).toEqual(['Preview'])
    expect(holdsFor(checks, 'all', null, 'acme/app').map((hold) => hold.name).sort()).toEqual(['Check', 'Preview'])
    const confirmed = holdsFor(checks, 'failed', new Set(['acme/app#7']), 'acme/app')
    expect(confirmed).toEqual([])
    const restarted = holdsFor(checks, 'all', new Set(['acme/app#7']), 'acme/app')
    expect(restarted.map((hold) => hold.name)).toEqual(['Check'])
    expect(displayCi(checks, activeHoldNames(checks, restarted))).toBe('yellow')
  })

  it('drops optimistic holds that GitHub did not restart', () => {
    const optimistic = new Map([
      ['acme/app#1', [
        { name: 'Check', stamp: 'a' },
        { name: 'Preview', stamp: 'b' },
      ]],
    ])
    const confirmed = new Map([['acme/app#1', [{ name: 'Check', stamp: 'a' }]]])
    expect([...(mergeHolds(withoutHolds(new Map(), optimistic), confirmed).get('acme/app#1') ?? [])]).toEqual([
      { name: 'Check', stamp: 'a' },
    ])
    expect(withoutHolds(optimistic, optimistic).size).toBe(0)
  })

  it('marks ruleset check names required even when GitHub says otherwise', () => {
    const checks = applyRequired([check({ name: 'Check', conclusion: 'FAILURE', required: false })], ['Check', 'Run'])
    expect(checks[0]?.required).toBe(true)
    expect(ciLevel(checks)).toBe('red')
  })
})

describe('rules', () => {
  it('reads active required status check contexts', () => {
    expect(
      requiredCheckNames([
        {
          enforcement: 'active',
          rules: [
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'Check' }, { context: 'Run' }] },
            },
          ],
        },
        { enforcement: 'disabled', rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Hidden' }] } }] },
      ]),
    ).toEqual(['Check', 'Run'])
  })
})

describe('approval', () => {
  it('treats a missing decision on a ready pull request as no requirement', () => {
    expect(mergeReview(null, false).mark).toBe('none')
    expect(mergeReview('APPROVED', false).mark).toBe('met')
    expect(mergeReview('REVIEW_REQUIRED', false).mark).toBe('unmet')
    expect(mergeReview(null, true).mark).toBe('draft')
  })

  it('separates any approval from a human approval', () => {
    const summary = summarizeReviews([
      { state: 'COMMENTED', submittedAt: '2026-10-20T10:00:00Z', author: { __typename: 'User', login: 'ada' } },
      { state: 'APPROVED', submittedAt: '2026-10-20T11:00:00Z', author: { __typename: 'Bot', login: 'cursor' } },
      { state: 'APPROVED', submittedAt: '2026-10-20T09:00:00Z', author: { __typename: 'User', login: 'ada' } },
      { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-20T12:00:00Z', author: { __typename: 'User', login: 'ada' } },
    ])
    expect(summary.anyApproval).toBe(true)
    expect(summary.humanApproval).toBe(false)
    expect(summary.changesRequested).toBe(true)
  })
})

describe('feedback', () => {
  it('counts unresolved threads whose latest human comment is not the author', () => {
    const summary = summarizeThreads(
      [
        {
          isResolved: false,
          comments: [
            { author: { __typename: 'Bot', login: 'coderabbitai' }, createdAt: '2026-10-20T10:00:00Z' },
            { author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T11:00:00Z' },
          ],
        },
        {
          isResolved: false,
          comments: [
            { author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T10:00:00Z' },
            { author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T12:00:00Z' },
          ],
        },
        {
          isResolved: true,
          comments: [{ author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
        {
          isResolved: false,
          comments: [{ author: { __typename: 'Bot', login: 'cursor' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
      ],
      'grace',
    )
    expect(summary.threadCount).toBe(4)
    expect(summary.unresolvedCount).toBe(3)
    expect(summary.awaitingYouCount).toBe(1)
    expect(summary.unreadCount).toBe(0)
    expect(summary.resolvedUnreadCount).toBe(0)
  })

  it('counts replies on threads the viewer joined, including ones resolved afterwards', () => {
    const summary = summarizeThreads(
      [
        {
          isResolved: false,
          comments: [
            { author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T10:00:00Z' },
            { author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T11:00:00Z' },
          ],
        },
        {
          isResolved: true,
          resolvedBy: 'ada',
          comments: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
        {
          isResolved: true,
          resolvedBy: 'grace',
          comments: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
        {
          isResolved: false,
          comments: [{ author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
      ],
      'grace',
    )
    expect(summary.unreadCount).toBe(1)
    expect(summary.resolvedUnreadCount).toBe(1)
    expect(summary.awaitingYouCount).toBe(2)
    expect(summary.unresolvedCount).toBe(2)
  })

  it('links the first matching thread and keeps a later one from replacing it', () => {
    const summary = summarizeThreads(
      [
        {
          isResolved: true,
          url: 'https://github.com/acme/app/pull/1#discussion_r1',
          comments: [{ author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T09:00:00Z' }],
        },
        {
          isResolved: false,
          url: 'https://github.com/acme/app/pull/1#discussion_r2',
          comments: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T10:00:00Z' }],
        },
        {
          isResolved: false,
          url: 'https://github.com/acme/app/pull/1#discussion_r3',
          comments: [
            { author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T11:00:00Z' },
            { author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T12:00:00Z' },
          ],
        },
        {
          isResolved: true,
          resolvedBy: 'ada',
          url: 'https://github.com/acme/app/pull/1#discussion_r4',
          comments: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T08:00:00Z' }],
        },
        {
          isResolved: false,
          url: 'https://github.com/acme/app/pull/1#discussion_r5',
          comments: [{ author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T13:00:00Z' }],
        },
      ],
      'grace',
    )
    expect(summary.unresolvedUrl).toBe('https://github.com/acme/app/pull/1#discussion_r2')
    expect(summary.awaitingUrl).toBe('https://github.com/acme/app/pull/1#discussion_r3')
    expect(summary.unreadUrl).toBe('https://github.com/acme/app/pull/1#discussion_r3')
    expect(summary.resolvedUnreadUrl).toBe('https://github.com/acme/app/pull/1#discussion_r4')
    expect(threadPermalink([
      { url: 'https://github.com/acme/app/pull/1#discussion_r1' },
      { url: null },
      { url: 'https://github.com/acme/app/pull/1#discussion_r9' },
    ])).toBe('https://github.com/acme/app/pull/1#discussion_r9')
  })

  it('counts an unanswered review message unless a later thread reply covers it', () => {
    const review = {
      author: { __typename: 'User', login: 'ada' },
      createdAt: '2026-10-20T12:00:00Z',
      body: 'Please rename this before merging.',
      kind: 'review' as const,
    }
    const chatter = {
      author: { __typename: 'User', login: 'ada' },
      createdAt: '2026-10-20T12:00:00Z',
      body: '@claude review',
      kind: 'comment' as const,
    }
    const thread = {
      isResolved: false,
      comments: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T13:00:00Z' }],
    }
    expect(summarizeNotes([], [review], 'grace')).toEqual({ author: 1, reviewer: 1 })
    expect(summarizeNotes([thread], [review], 'grace')).toEqual({ author: 0, reviewer: 0 })
    expect(summarizeNotes([], [{ ...review, body: '   ' }], 'grace')).toEqual({ author: 0, reviewer: 0 })
    expect(summarizeNotes([], [chatter], 'grace')).toEqual({ author: 1, reviewer: 0 })
    expect(summarizeNotes([], [
      { ...chatter, author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T11:00:00Z', body: 'Looking' },
      chatter,
    ], 'grace')).toEqual({ author: 1, reviewer: 1 })
  })

  it('classifies a thread into the same buckets the counts use', () => {
    const thread = {
      isResolved: false,
      url: 'https://github.com/acme/app/pull/1#discussion_r3',
      comments: [
        { author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-20T11:00:00Z' },
        { author: { __typename: 'User', login: 'ada' }, createdAt: '2026-10-20T12:00:00Z' },
      ],
    }
    expect(threadKinds(thread, 'grace')).toEqual(['unresolved', 'awaiting', 'unread'])
    expect(feedbackCounts([thread], [], 'grace', false)).toMatchObject({
      threadCount: 1,
      unresolvedCount: 1,
      awaitingYouCount: 1,
      unreadCount: 1,
      resolvedUnreadCount: 0,
      awaitingThreadUrl: thread.url,
      commentAwaitingCount: 0,
      threadsTruncated: false,
    })
  })

  it('quotes a conversation comment, mentions the author, and links to that comment', () => {
    expect(quoteReply({
      authorLogin: 'ada',
      body: 'Please rename this.\n\nThanks',
      url: 'https://github.com/acme/app/pull/1#issuecomment-9',
    }, '  Done in the latest commit.  ')).toBe(
      [
        '@ada',
        'https://github.com/acme/app/pull/1#issuecomment-9',
        '',
        '> Please rename this.',
        '> ',
        '> Thanks',
        '',
        'Done in the latest commit.',
      ].join('\n'),
    )
    expect(quoteReply({ authorLogin: null, body: 'Hello', url: null }, 'OK')).toBe('> Hello\n\nOK')
    expect(() => quoteReply({ authorLogin: 'ada', body: 'Hi', url: null }, '  ')).toThrow(/Write a reply/)
  })
})

describe('review search', () => {
  it('keeps your own pull requests out and includes team review requests', () => {
    expect(reviewSearchQueries([])).toEqual([
      'is:open is:pr archived:false -author:@me review-requested:@me',
      'is:open is:pr archived:false -author:@me reviewed-by:@me',
    ])
    expect(reviewSearchQueries(['initech/eng'])).toContain(
      'is:open is:pr archived:false -author:@me team-review-requested:initech/eng',
    )
  })
})

describe('linear', () => {
  it('parses a Linear linkback and ignores issues mentioned only in the description', () => {
    const issues = parseLinear({
      title: 'feat(app): rate the summary (ENG-101)',
      headRef: 'cursor/eng-101-summary-rating-cf64',
      comments: [
        {
          body: '<!-- linear-linkback -->\n<summary><a href="https://linear.app/acme/issue/ENG-101/fe-summary">ENG-101 FE: Summary states</a></summary>\nContract change ([ENG-100](https://linear.app/acme/issue/ENG-100/be-summary))',
        },
      ],
    })
    expect(parseLinear({
      title: 'feat(app): track write actions',
      headRef: 'cursor/write-events-7338',
      comments: [],
    })).toEqual([])
    expect(parseLinear({
      title: 'refactor accounts',
      headRef: 'OPS-1146/refactor/accounts-by-owner',
      comments: [],
    }).map((issue) => issue.identifier)).toEqual(['OPS-1146'])
    expect(issues).toEqual([
      {
        identifier: 'ENG-101',
        title: 'FE: Summary states',
        url: 'https://linear.app/acme/issue/ENG-101/fe-summary',
        projectId: null,
        projectName: null,
        teamId: null,
        status: null,
        assignee: null,
      },
    ])
  })
})

function pr(over: Partial<PullRequest> & Pick<PullRequest, 'id' | 'number' | 'baseRef' | 'headRef'>): PullRequest {
  return {
    key: `initech/frontend#${over.number}`,
    repo: 'initech/frontend',
    repoName: 'frontend',
    title: `PR ${over.number}`,
    url: `https://github.com/initech/frontend/pull/${over.number}`,
    author: 'grace',
    authorAvatarUrl: null,
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: `2026-10-0${over.number}T00:00:00Z`,
    committedAt: null,
    additions: 10,
    deletions: 1,
    changedFiles: 1,
    defaultBranch: 'main',
    squashMergeAllowed: true,
    requiredApprovals: 0,
    dismissStale: false,
    requiredCheckNames: [],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    mergeMark: 'none',
    mergeDetail: '',
    anyApproval: false,
    humanApproval: false,
    changesRequested: false,
    reviewers: [],
    conflict: false,
    behind: false,
    checks: [],
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

describe('stacks and grouping', () => {
  const stack = [
    pr({ id: 'a', number: 1, baseRef: 'dev', headRef: 'branch-a', title: 'bottom' }),
    pr({ id: 'b', number: 2, baseRef: 'branch-a', headRef: 'branch-b', title: 'middle' }),
    pr({ id: 'c', number: 3, baseRef: 'branch-b', headRef: 'branch-c', title: 'top' }),
  ]

  it('orders a stack from the top pull request down to the trunk', () => {
    const stacks = buildStacks(stack)
    expect(stacks).toHaveLength(1)
    expect(stacks[0]?.prs.map((item) => item.number)).toEqual([3, 2, 1])
    expect(stacks[0]?.trunk).toBe('dev')
  })

  it('points a collapsed stack at the first pull request with each kind of thread', () => {
    const summary = summarize(
      [
        pr({
          id: 'c',
          number: 3,
          baseRef: 'branch-b',
          headRef: 'branch-c',
          unresolvedThreadUrl: 'https://github.com/acme/app/pull/3#discussion_r3',
        }),
        pr({
          id: 'b',
          number: 2,
          baseRef: 'branch-a',
          headRef: 'branch-b',
          awaitingThreadUrl: 'https://github.com/acme/app/pull/2#discussion_r2',
          unresolvedThreadUrl: 'https://github.com/acme/app/pull/2#discussion_r8',
          unreadThreadUrl: 'https://github.com/acme/app/pull/2#discussion_r2',
        }),
      ],
      false,
    )
    expect(summary.unresolvedThreadUrl).toBe('https://github.com/acme/app/pull/3#discussion_r3')
    expect(summary.awaitingThreadUrl).toBe('https://github.com/acme/app/pull/2#discussion_r2')
    expect(summary.unreadThreadUrl).toBe('https://github.com/acme/app/pull/2#discussion_r2')
    expect(summary.resolvedUnreadThreadUrl).toBeNull()
    expect(summary.url).toBe('https://github.com/initech/frontend/pull/3')
  })

  it('restacks the chosen pull request and everything above it', () => {
    const ordered = buildStacks(stack)[0]!.prs
    expect(restackChain(ordered, ordered[2]!.key)?.map((item) => item.number)).toEqual([1, 2, 3])
    expect(restackChain(ordered, ordered[1]!.key)?.map((item) => item.number)).toEqual([2, 3])
    expect(restackChain(ordered, ordered[0]!.key)?.map((item) => item.number)).toEqual([3])
    expect(restackChain(ordered, 'missing')).toBeNull()
  })

  it('does not link pull requests across repositories', () => {
    const other = pr({
      id: 'z',
      number: 9,
      repo: 'initech/backend',
      repoName: 'backend',
      key: 'initech/backend#9',
      baseRef: 'branch-c',
      headRef: 'elsewhere',
    })
    const stacks = buildStacks([...stack, other])
    expect(stacks).toHaveLength(2)
  })

  it('shows a partial stack with rows above and below an issue slice', () => {
    const prs = [
      pr({
        id: 'a',
        number: 1,
        baseRef: 'dev',
        headRef: 'branch-a',
        linearIssues: [{ identifier: 'ENG-1', title: 'Bottom', url: null, projectId: null, projectName: null }],
      }),
      pr({
        id: 'b',
        number: 2,
        baseRef: 'branch-a',
        headRef: 'branch-b',
        linearIssues: [{ identifier: 'ENG-2', title: 'Middle', url: null, projectId: null, projectName: null }],
      }),
      pr({
        id: 'c',
        number: 3,
        baseRef: 'branch-b',
        headRef: 'branch-c',
        linearIssues: [{ identifier: 'ENG-1', title: 'Bottom', url: null, projectId: null, projectName: null }],
      }),
    ]
    const view = buildOutline(prs, [], DEFAULT_FILTERS, DEFAULT_SORT)
    const eng1 = view.looseIssues.find((section) => section.issueId === 'ENG-1')
    expect(eng1?.stacks).toHaveLength(1)
    expect(eng1?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : `${row.place}:${row.count}`))).toEqual([
      3,
      'between:1',
      1,
    ])
    const eng2 = view.looseIssues.find((section) => section.issueId === 'ENG-2')
    expect(eng2?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : `${row.place}:${row.count}`))).toEqual([
      'above:1',
      2,
      'below:1',
    ])
  })

  it('shows a stack once, intact, when not grouped by issue', () => {
    const prs = [
      pr({
        id: 'a',
        number: 1,
        baseRef: 'dev',
        headRef: 'branch-a',
        initiativeIds: ['cleanup'],
        linearIssues: [{ identifier: 'ENG-1', title: 'Bottom', url: null, projectId: 'p1', projectName: 'Updates' }],
      }),
      pr({
        id: 'b',
        number: 2,
        baseRef: 'branch-a',
        headRef: 'branch-b',
        linearIssues: [{ identifier: 'ENG-2', title: 'Middle', url: null, projectId: null, projectName: null }],
      }),
      pr({
        id: 'c',
        number: 3,
        baseRef: 'branch-b',
        headRef: 'branch-c',
        linearIssues: [{ identifier: 'ENG-1', title: 'Bottom', url: null, projectId: 'p1', projectName: 'Updates' }],
      }),
    ]
    const view = buildOutline(
      prs,
      [{ id: 'cleanup', name: 'Auth cleanup', createdAt: '', updatedAt: '' }],
      DEFAULT_FILTERS,
      DEFAULT_SORT,
      'author',
      false,
    )
    expect(view.projects).toEqual([])
    expect(view.initiatives).toEqual([])
    expect(view.looseIssues).toEqual([])
    expect(view.unassigned?.stacks).toHaveLength(1)
    expect(view.unassigned?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : row.place))).toEqual([3, 2, 1])
  })

  it('groups a tagged slice of a stack under an initiative', () => {
    const prs = stack.map((item) =>
      item.number === 1 || item.number === 2 ? { ...item, initiativeIds: ['cleanup'] } : item,
    )
    const view = buildOutline(
      prs,
      [{ id: 'cleanup', name: 'Auth cleanup', createdAt: '', updatedAt: '' }],
      DEFAULT_FILTERS,
      DEFAULT_SORT,
    )
    const cleanup = view.initiatives.find((section) => section.id === 'initiative:cleanup')
    expect(cleanup?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : row.place))).toEqual([
      'above',
      2,
      1,
    ])
    expect(view.unassigned?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : row.place))).toEqual([
      3,
      'below',
    ])
  })

  it('keeps filtered-out siblings as ellipsis inside the stack', () => {
    const prs = [
      { ...stack[0]!, ci: 'green' as const },
      { ...stack[1]!, ci: 'red' as const },
      { ...stack[2]!, ci: 'green' as const },
    ]
    const view = buildOutline(prs, [], { ...DEFAULT_FILTERS, ci: 'red' }, DEFAULT_SORT)
    expect(view.unassigned?.stacks).toHaveLength(1)
    expect(view.unassigned?.stacks[0]?.rows.map((row) => (row.type === 'pr' ? row.pr.number : row.reason))).toEqual([
      'filtered out',
      2,
      'filtered out',
    ])
    expect(view.unassigned?.stacks[0]?.summary.partial).toBe(true)
    expect(view.unassigned?.stacks[0]?.summary.title).toBe('middle')
  })

  it('sorts pull requests by the most recently updated one', () => {
    const older = pr({ id: 'old', number: 8, baseRef: 'dev', headRef: 'old', updatedAt: '2026-10-01T00:00:00Z', title: 'older' })
    const newer = pr({ id: 'new', number: 9, baseRef: 'dev', headRef: 'new', updatedAt: '2026-10-20T00:00:00Z', title: 'newer' })
    const view = buildOutline([older, newer], [], DEFAULT_FILTERS, DEFAULT_SORT)
    expect(view.unassigned?.singles.map((block) => block.summary.title)).toEqual(['newer', 'older'])
  })

  it('lists a pull request under every issue it is linked to', () => {
    const linked = pr({
      id: 'multi',
      number: 7,
      baseRef: 'dev',
      headRef: 'multi',
      linearIssues: [
        { identifier: 'ENG-1', title: 'Parent', url: null, projectId: 'p', projectName: 'Billing' },
        { identifier: 'ENG-2', title: 'Child', url: null, projectId: 'p', projectName: 'Billing' },
      ],
    })
    const view = buildOutline([linked], [], DEFAULT_FILTERS, DEFAULT_SORT)
    const issues = view.projects[0]?.issues ?? []
    expect(issues.map((issue) => issue.issueId).sort()).toEqual(['ENG-1', 'ENG-2'])
    for (const issue of issues) {
      expect(issue.singles.flatMap((block) => block.rows.flatMap((row) => (row.type === 'pr' ? [row.pr.number] : [])))).toEqual([
        7,
      ])
    }
  })

  it('keeps a tagged pull request under its Linear project', () => {
    const tagged = pr({
      id: 'p',
      number: 4,
      baseRef: 'dev',
      headRef: 'proj',
      initiativeIds: ['cleanup'],
      linearIssues: [{ identifier: 'ENG-9', title: 'Ship it', url: null, projectId: 'p1', projectName: 'Updates' }],
    })
    const loose = pr({
      id: 'l',
      number: 5,
      baseRef: 'dev',
      headRef: 'loose',
      linearIssues: [{ identifier: 'ENG-8', title: 'Loose', url: null, projectId: null, projectName: null }],
    })
    const view = buildOutline(
      [tagged, loose],
      [{ id: 'cleanup', name: 'Auth cleanup', createdAt: '', updatedAt: '' }],
      DEFAULT_FILTERS,
      DEFAULT_SORT,
    )
    expect(view.projects.map((project) => project.title)).toEqual(['Updates'])
    expect(view.projects[0]?.issues[0]?.singles.map((block) => block.summary.number)).toEqual([4])
    expect(view.initiatives).toEqual([])
    expect(view.looseIssues.map((issue) => issue.issueId)).toEqual(['ENG-8'])
    expect(view.unassigned).toBeNull()
  })
})

describe('squash merge', () => {
  const ready = pr({
    id: 'm',
    number: 8,
    baseRef: 'main',
    headRef: 'ship-it',
    defaultBranch: 'main',
  })

  it('allows a clean pull request that targets the default branch', () => {
    expect(canSquashMerge(ready)).toBe(true)
    expect(canSquashMerge({ ...ready, mergeStateStatus: 'UNSTABLE' })).toBe(true)
    expect(canSquashMerge({ ...ready, mergeStateStatus: 'HAS_HOOKS' })).toBe(true)
  })

  it('refuses a pull request that would squash into another branch', () => {
    expect(canSquashMerge({ ...ready, baseRef: 'feature' })).toBe(false)
  })

  it('refuses drafts, conflicts, a behind branch, a blocked review, and an unknown merge', () => {
    expect(canSquashMerge({ ...ready, isDraft: true })).toBe(false)
    expect(canSquashMerge({ ...ready, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe(false)
    expect(canSquashMerge({ ...ready, mergeStateStatus: 'BEHIND' })).toBe(false)
    expect(canSquashMerge({ ...ready, mergeStateStatus: 'BLOCKED' })).toBe(false)
    expect(canSquashMerge({ ...ready, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toBe(false)
    expect(canSquashMerge({ ...ready, squashMergeAllowed: false })).toBe(false)
  })

  it('refuses a pull request with unresolved threads and still allows resolved ones', () => {
    expect(canSquashMerge({ ...ready, threadCount: 2, unresolvedCount: 1 })).toBe(false)
    expect(canSquashMerge({ ...ready, threadCount: 3, unresolvedCount: 0 })).toBe(true)
  })
})
