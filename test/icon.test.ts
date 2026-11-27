import { describe, expect, it } from 'vitest'
import { iconState, iconSvg } from '../src/shared/icon.ts'
import type { PullRequest, Snapshot } from '../src/shared/types.ts'
import { pullRequest } from './support/pull.ts'

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return { ...pullRequest(number), key: `acme/app#${number}`, repo: 'acme/app', number, isDraft: false, ci: 'green', awaitingYouCount: 0, commentAwaitingCount: 0, unreadCount: 0, reviewCommentAwaitingCount: 0, reviewPending: false, squashMergeAllowed: false, ...over }
}

function snapshot(mine: PullRequest[], review: PullRequest[] = []): Snapshot {
  return { viewer: 'me', syncedAt: null, mineSyncedAt: null, reviewSyncedAt: null, repos: ['acme/app'], pullRequests: mine, reviewPullRequests: review, initiatives: [], linearConfigured: false, warning: null }
}

describe('the app icon', () => {
  it('is the plain icon until the list is known', () => {
    expect(iconState(null, null)).toEqual({ tone: 'idle', count: 0, merging: false })
  })

  it('takes the most urgent state: broken, then waiting on you, then clear', () => {
    expect(iconState(snapshot([pr(1)]), null).tone).toBe('clear')
    expect(iconState(snapshot([pr(1, { awaitingYouCount: 2 })], [pr(2, { reviewPending: true })]), null)).toMatchObject({ tone: 'needs', count: 2 })
    expect(iconState(snapshot([pr(1, { awaitingYouCount: 2 }), pr(3, { ci: 'red' })]), null)).toMatchObject({ tone: 'broken', count: 1 })
    // A failing draft is not waiting on anyone, and a held merge is broken whatever the lists say.
    expect(iconState(snapshot([pr(3, { ci: 'red', isDraft: true })]), null).tone).toBe('clear')
    expect(iconState(snapshot([pr(1)]), { state: 'failed', held: 1 }).tone).toBe('broken')
  })

  it('leaves out repositories that are no longer synced', () => {
    expect(iconState(snapshot([pr(1, { repo: 'acme/old', ci: 'red' })]), null).tone).toBe('clear')
  })

  it('ripples its bars while the queue works, and counts what waits', () => {
    const merging = iconState(snapshot([pr(1)]), { state: 'active', held: 0 })
    expect(merging.merging).toBe(true)
    expect(iconSvg(merging, 0)).not.toBe(iconSvg(merging, 1))
    expect(iconSvg({ tone: 'needs', count: 12, merging: false })).toContain('>9+<')
    expect(iconSvg({ tone: 'broken', count: 0, merging: false }, 0, true)).toContain('viewBox="0 0 1024 1024"')
  })
})
