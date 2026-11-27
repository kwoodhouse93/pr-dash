import { describe, expect, it } from 'vitest'
import { needsFreshBehind, needsFreshChecks, planCheckReads, readsAfterProbe } from '../src/shared/freshness.ts'
import type { Check, CheckCursor, PullRequest } from '../src/shared/types.ts'
import { pullRequest } from './support/pull.ts'

const now = Date.parse('2026-11-05T12:00:00Z')

const passed: Check = {
  name: 'build',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  required: true,
  url: null,
  workflowName: 'CI',
  workflowRunId: 1,
  startedAt: null,
  completedAt: '2026-11-05T11:00:00Z',
}

function cursor(readAt: string, over: Partial<CheckCursor> = {}): CheckCursor {
  return { oid: 'abc', rollup: 'SUCCESS', count: 4, readAt, ...over }
}

function row(over: Partial<PullRequest> = {}): PullRequest {
  return {
    ...pullRequest(1),
    id: 'pr-1',
    updatedAt: '2026-11-05T11:00:00Z',
    checks: [passed],
    checkCursor: cursor(new Date(now - 60_000).toISOString()),
    requiredCheckNames: ['build'],
    committedAt: '2026-11-05T11:00:00Z',
    ...over,
  } as PullRequest
}

describe('check freshness', () => {
  it('keeps a settled pull request on the cheap comparison', () => {
    const previous = new Map([['pr-1', row()]])
    expect(needsFreshChecks(previous.get('pr-1'), '2026-11-05T11:00:00Z')).toBe(false)
    expect(planCheckReads([{ id: 'pr-1', updatedAt: '2026-11-05T11:00:00Z' }], previous, false)).toEqual({
      fetch: [],
      probe: ['pr-1'],
    })
  })

  it('reads checks again when the pull request moved, checks are running, or nothing is stored yet', () => {
    const running = row({
      checks: [{ ...passed, status: 'IN_PROGRESS', conclusion: null }],
    })
    const missing = row({ checks: [], requiredCheckNames: ['build'] })
    expect(needsFreshChecks(undefined, '2026-11-05T11:00:00Z')).toBe(true)
    expect(needsFreshChecks(row({ checkCursor: null }), '2026-11-05T11:00:00Z')).toBe(true)
    expect(needsFreshChecks(row(), '2026-11-05T11:05:00Z')).toBe(true)
    expect(needsFreshChecks(running, running.updatedAt)).toBe(true)
    expect(needsFreshChecks(missing, missing.updatedAt)).toBe(true)
    expect(needsFreshChecks(row({ checks: [{ ...passed, unreported: true, conclusion: null, status: null }] }), '2026-11-05T11:00:00Z')).toBe(true)
    const graphite = row({
      ci: 'green',
      checks: [passed, { ...passed, name: 'Graphite / mergeability_check', status: 'IN_PROGRESS', conclusion: null, required: false }],
    })
    expect(needsFreshChecks(graphite, graphite.updatedAt)).toBe(false)
    const onlyOptional = row({
      requiredCheckNames: [],
      checks: [{ ...passed, required: false, status: 'IN_PROGRESS', conclusion: null }],
    })
    expect(needsFreshChecks(onlyOptional, onlyOptional.updatedAt)).toBe(true)
  })

  it('reuses a matching rollup and rereads the oldest settled pull requests a few at a time', () => {
    const fresh = row({ id: 'fresh' })
    const stale = Array.from({ length: 10 }, (_, index) =>
      row({
        id: `old-${index}`,
        checkCursor: cursor(new Date(now - 60 * 60_000 - index * 1000).toISOString()),
      }),
    )
    const changed = row({ id: 'changed' })
    const previous = new Map([fresh, ...stale, changed].map((pr) => [pr.id, pr]))
    const seen = new Map(
      [fresh, ...stale, changed].map((pr) => [pr.id, { oid: 'abc', rollup: pr.id === 'changed' ? 'PENDING' : 'SUCCESS', count: 4 }]),
    )
    const ids = [fresh, ...stale, changed].map((pr) => pr.id)
    const decided = readsAfterProbe(ids, previous, seen, now)
    expect(decided.fetch).toContain('changed')
    expect(decided.reuse).toContain('fresh')
    expect(decided.fetch.filter((id) => id.startsWith('old-')).sort()).toEqual(['old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7', 'old-8', 'old-9'])
    expect(decided.reuse.filter((id) => id.startsWith('old-')).sort()).toEqual(['old-0', 'old-1'])
  })
})

describe('behind freshness', () => {
  const same = { updatedAt: '2026-11-05T11:00:00Z', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }

  it('skips the comparison when the merge state is unchanged and already settled', () => {
    expect(needsFreshBehind(row(), same)).toBe(false)
    expect(needsFreshBehind(row({ behind: true, mergeStateStatus: 'BLOCKED' }), { ...same, mergeStateStatus: 'BLOCKED' })).toBe(false)
  })

  it('compares again when the base may have moved without a new pull request update', () => {
    expect(needsFreshBehind(undefined, same)).toBe(true)
    expect(needsFreshBehind(row(), { ...same, updatedAt: '2026-11-05T12:00:00Z' })).toBe(true)
    expect(needsFreshBehind(row(), { ...same, mergeStateStatus: 'BEHIND' })).toBe(true)
    expect(needsFreshBehind(row({ mergeStateStatus: 'BLOCKED' }), { ...same, mergeStateStatus: 'BLOCKED' })).toBe(true)
    expect(needsFreshBehind(row(), { ...same, mergeStateStatus: 'UNKNOWN' })).toBe(true)
  })
})
