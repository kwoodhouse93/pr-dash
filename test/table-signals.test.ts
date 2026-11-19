import { describe, expect, it } from 'vitest'
import { mapPullRequest, type GitHubPull } from '../src/shared/map.ts'
import { defaultRepoMark, REPO_COLORS, REPO_ICONS, repoMarkOf, validRepoMark } from '../src/shared/repo-marks.ts'
import { rollup, segmentState } from '../src/shared/segments.ts'
import { summarize } from '../src/shared/stacks.ts'
import type { PullRequest } from '../src/shared/types.ts'
import { ageHeat } from '../src/web/format.ts'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-19T12:00:00Z')
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'a',
    key: 'acme/app#1',
    repo: 'acme/app',
    repoName: 'app',
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/acme/app/pull/1',
    author: 'ada',
    authorAvatarUrl: null,
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    committedAt: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    baseRef: 'main',
    headRef: 'topic',
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

function githubPull(over: Partial<GitHubPull> = {}): GitHubPull {
  return {
    id: 'pr-1',
    number: 7,
    title: 'Topic',
    url: 'https://github.com/acme/app/pull/7',
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
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: { nodes: [] },
    ...over,
  }
}

const extras = { viewer: 'ada', requiredNames: [], requiredApprovals: 0, dismissStale: false, committedAt: null, checks: [] }

describe('age colour', () => {
  it('stays plain for the first three hours', () => {
    expect(ageHeat(ago(1), NOW).level).toBe('none')
    expect(ageHeat(ago(3), NOW).level).toBe('none')
  })

  it('warms from three hours to a day, then holds until two days', () => {
    expect(ageHeat(ago(13.5), NOW)).toEqual({ level: 'warm', warmth: 0.5 })
    expect(ageHeat(ago(24), NOW)).toEqual({ level: 'warm', warmth: 1 })
    expect(ageHeat(ago(40), NOW)).toEqual({ level: 'warm', warmth: 1 })
  })

  it('turns red past two days', () => {
    expect(ageHeat(ago(49), NOW).level).toBe('hot')
  })

  it('has no colour without a time, which is how a draft is passed', () => {
    expect(ageHeat(null, NOW).level).toBe('none')
  })
})

describe('time a pull request became ready for review', () => {
  it('is when it was opened if it was never a draft', () => {
    expect(mapPullRequest(githubPull(), extras).readyAt).toBe('2026-10-01T00:00:00Z')
  })

  it('is the last time it left draft', () => {
    const pull = githubPull({ readyEvents: { nodes: [{ createdAt: '2026-10-09T08:00:00Z' }] } })
    expect(mapPullRequest(pull, extras).readyAt).toBe('2026-10-09T08:00:00Z')
  })

  it('is empty while it is a draft, even if it was ready before', () => {
    const pull = githubPull({ isDraft: true, readyEvents: { nodes: [{ createdAt: '2026-10-09T08:00:00Z' }] } })
    expect(mapPullRequest(pull, extras).readyAt).toBeNull()
  })

  it('on a stack is the earliest among the pull requests out of draft', () => {
    const stack = [
      pr({ id: 'a', readyAt: '2026-10-05T00:00:00Z' }),
      pr({ id: 'b', readyAt: '2026-10-03T00:00:00Z' }),
      pr({ id: 'c', isDraft: true, readyAt: null }),
    ]
    expect(summarize(stack, false).readyAt).toBe('2026-10-03T00:00:00Z')
    expect(summarize([pr({ isDraft: true, readyAt: null })], false).readyAt).toBeNull()
  })
})

describe('repository icon', () => {
  it('gives a repository the same default every time, from the lists', () => {
    const mark = defaultRepoMark('acme/app')
    expect(defaultRepoMark('acme/app')).toEqual(mark)
    expect(Object.keys(REPO_ICONS)).toContain(mark.icon)
    expect(REPO_COLORS).toContain(mark.color)
  })

  it('uses a saved pick, and falls back when the saved pick is no longer offered', () => {
    const saved = { icon: 'flask', color: REPO_COLORS[0]! }
    expect(repoMarkOf('acme/app', { 'acme/app': saved })).toEqual(saved)
    expect(repoMarkOf('acme/app', { 'acme/app': { icon: 'gone', color: '#fff' } })).toEqual(defaultRepoMark('acme/app'))
  })

  it('accepts only icons and colours from the lists', () => {
    expect(validRepoMark({ icon: 'flask', color: REPO_COLORS[0] })).toBe(true)
    expect(validRepoMark({ icon: 'flask', color: 'red' })).toBe(false)
    expect(validRepoMark({ icon: 'toString', color: REPO_COLORS[0] })).toBe(false)
  })
})

describe('where a pull request stands', () => {
  it('on My PRs puts broken first, then needing you, then draft, then ready', () => {
    const ready = pr()
    expect(segmentState(ready, [ready], 'mine', 'ada')).toBe('ready')
    expect(segmentState(pr({ isDraft: true }), [], 'mine', 'ada')).toBe('draft')
    expect(segmentState(pr({ isDraft: true, awaitingYouCount: 1 }), [], 'mine', 'ada')).toBe('you')
    expect(segmentState(pr({ awaitingYouCount: 1, conflict: true }), [], 'mine', 'ada')).toBe('broken')
    expect(segmentState(pr({ ci: 'red' }), [], 'mine', 'ada')).toBe('broken')
    expect(segmentState(pr({ mergeStateStatus: 'BLOCKED' }), [], 'mine', 'ada')).toBe('waiting')
  })

  it('counts a stacked pull request as ready when it could merge with what is below it', () => {
    const bottom = pr({ id: 'a', key: 'acme/app#1', headRef: 'one' })
    const top = pr({ id: 'b', key: 'acme/app#2', number: 2, baseRef: 'one', headRef: 'two' })
    expect(segmentState(top, [top, bottom], 'mine', 'ada')).toBe('ready')
    const stuck = { ...bottom, unresolvedCount: 1 }
    expect(segmentState(top, [top, stuck], 'mine', 'ada')).toBe('waiting')
  })

  it('on Review is ready once you approved it', () => {
    const approved = pr({ reviewers: [{ login: 'grace', human: true, state: 'APPROVED', submittedAt: null }] })
    expect(segmentState(approved, [], 'review', 'grace')).toBe('ready')
    expect(segmentState(approved, [], 'review', 'ada')).toBe('waiting')
    expect(segmentState(pr({ unreadCount: 2 }), [], 'review', 'ada')).toBe('you')
  })

  it('rolls up the counts a heading shows', () => {
    expect(rollup(['ready', 'ready', 'you', 'waiting', 'draft', 'broken'])).toEqual({ ready: 2, you: 1, broken: 1 })
  })
})
