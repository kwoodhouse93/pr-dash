import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GRAPHQL_PAUSE_BELOW, GRAPHQL_SINGLE_FLOOR, budgetFromHeaders, graphqlView } from '../src/shared/budget.ts'
import { carryThreadFeedback } from '../src/shared/feedback.ts'
import { applyThreadDetails, mapPullRequest, type GitHubPull, type ThreadDetail } from '../src/shared/map.ts'
import { rulesFresh } from '../src/shared/rules.ts'
import type { PullRequest } from '../src/shared/types.ts'
import { openDatabase } from '../src/server/db.ts'

describe('graphql budget', () => {
  const now = Date.parse('2026-10-21T13:00:00Z')
  const budget = { limit: 5000, remaining: 180, resetAt: Date.parse('2026-10-21T14:00:00Z') }

  it('pauses list refreshes below 200 points and still allows one pull request', () => {
    expect(graphqlView(budget, now, GRAPHQL_PAUSE_BELOW).paused).toBe(true)
    expect(graphqlView(budget, now, GRAPHQL_SINGLE_FLOOR).paused).toBe(false)
    expect(graphqlView({ ...budget, remaining: 0 }, now).message).toMatch(/paused until/i)
  })

  it('clears the pause after the window resets', () => {
    const view = graphqlView(budget, budget.resetAt, GRAPHQL_PAUSE_BELOW)
    expect(view.paused).toBe(false)
    expect(view.remaining).toBeNull()
  })

  it('reads the graphql headers', () => {
    const headers = new Headers({
      'x-ratelimit-resource': 'graphql',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '250',
      'x-ratelimit-reset': '1792591200',
    })
    expect(budgetFromHeaders(headers)).toEqual({ limit: 5000, remaining: 250, resetAt: 1792591200 * 1000 })
    expect(budgetFromHeaders(new Headers({ 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1' }))).toBeNull()
  })
})

describe('ruleset age', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')

  it('treats a ruleset as fresh for a day', () => {
    expect(rulesFresh('2026-10-20T12:00:01Z', now)).toBe(true)
    expect(rulesFresh('2026-10-20T12:00:00Z', now)).toBe(false)
    expect(rulesFresh(null, now)).toBe(false)
  })
})

describe('thread feedback', () => {
  it('keeps reply counts when the pull request has not changed', () => {
    const next = { updatedAt: '2026-10-21T00:00:00Z', awaitingYouCount: 0, feedbackAt: null } as PullRequest
    const previous = { ...next, awaitingYouCount: 2, feedbackAt: next.updatedAt } as PullRequest
    expect(carryThreadFeedback(previous, next).awaitingYouCount).toBe(2)
    expect(carryThreadFeedback({ ...previous, feedbackAt: '2026-10-20T00:00:00Z' }, next).awaitingYouCount).toBe(0)
  })

  it('counts unresolved threads without loading replies', () => {
    const pull = mapPullRequest(githubPull(), {
      viewer: 'ada',
      requiredNames: [],
      requiredApprovals: 0,
      dismissStale: false,
      committedAt: null,
      checks: [],
    })
    expect(pull.threadCount).toBe(1)
    expect(pull.unresolvedCount).toBe(1)
    expect(pull.awaitingYouCount).toBe(0)
    expect(pull.feedbackAt).toBeNull()
  })

  it('fills reply counts from a later thread read', () => {
    const pull = mapPullRequest(githubPull(), {
      viewer: 'ada',
      requiredNames: [],
      requiredApprovals: 0,
      dismissStale: false,
      committedAt: null,
      checks: [],
    })
    const detail: ThreadDetail = {
      updatedAt: pull.updatedAt,
      reviews: { nodes: [] },
      latestComments: { nodes: [] },
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            isResolved: false,
            isOutdated: false,
            comments: { nodes: [{ author: { __typename: 'User', login: 'grace' }, createdAt: '2026-10-21T01:00:00Z', url: 'https://github.com/acme/app/pull/1#discussion_r1' }] },
          },
        ],
      },
    }
    const next = applyThreadDetails(pull, detail, 'ada')
    expect(next.awaitingYouCount).toBe(1)
    expect(next.feedbackAt).toBe(pull.updatedAt)
    expect(next.awaitingThreadUrl).toBe('https://github.com/acme/app/pull/1#discussion_r1')
  })
})

describe('saved rulesets', () => {
  it('keeps rulesets and per-list sync times', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-rules-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    db.saveRules('acme/app', { checks: ['ci'], requiredApprovals: 1, dismissStale: true }, '2026-10-21T00:00:00Z')
    db.saveSnapshot({
      viewer: 'ada',
      syncedAt: '2026-10-21T01:00:00Z',
      mineSyncedAt: '2026-10-21T01:00:00Z',
      pullRequests: [],
      linearConfigured: false,
      warning: null,
    })
    const again = db.saveSnapshot({
      viewer: 'ada',
      syncedAt: '2026-10-21T02:00:00Z',
      reviewSyncedAt: '2026-10-21T02:00:00Z',
      pullRequests: [],
      linearConfigured: false,
      warning: null,
    })
    expect(db.ruleCache()).toEqual([
      { repo: 'acme/app', checks: ['ci'], requiredApprovals: 1, dismissStale: true, fetchedAt: '2026-10-21T00:00:00Z' },
    ])
    expect(again.mineSyncedAt).toBe('2026-10-21T01:00:00Z')
    expect(again.reviewSyncedAt).toBe('2026-10-21T02:00:00Z')
  })
})

function githubPull(): GitHubPull {
  return {
    id: 'pr-1',
    number: 1,
    title: 'Topic',
    url: 'https://github.com/acme/app/pull/1',
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    baseRefName: 'main',
    headRefName: 'topic',
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    author: { login: 'ada' },
    repository: { nameWithOwner: 'acme/app', name: 'app', squashMergeAllowed: true, defaultBranchRef: { name: 'main' } },
    reviews: { nodes: [] },
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [{ isResolved: false, isOutdated: false, comments: undefined }],
    },
    comments: { nodes: [] },
  }
}
