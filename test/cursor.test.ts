import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cursorLinks, cursorPushedBranch, cursorSessionStatus, leadingCursorStatus } from '../src/shared/cursor.ts'
import type { PullRequest } from '../src/shared/types.ts'
import { openDatabase } from '../src/server/db.ts'

describe('cursor sessions', () => {
  it('maps Cursor run statuses and keeps an unknown status active', () => {
    expect(cursorSessionStatus('CREATING')).toBe('creating')
    expect(cursorSessionStatus('RUNNING')).toBe('running')
    expect(cursorSessionStatus('FINISHED')).toBe('finished')
    expect(cursorSessionStatus('ERROR')).toBe('failed')
    expect(cursorSessionStatus('CANCELLED')).toBe('cancelled')
    expect(cursorSessionStatus('EXPIRED')).toBe('expired')
    expect(cursorSessionStatus('SOMETHING_NEW')).toBe('running')
  })

  it('prefers a running session over a finished one', () => {
    expect(leadingCursorStatus(['finished', 'failed', 'running'])).toBe('running')
    expect(leadingCursorStatus([])).toBeNull()
  })

  it('reads the pushed branch and builds both session links', () => {
    expect(cursorPushedBranch({ branches: [{ branch: null }, { branch: 'feature' }] })).toBe('feature')
    expect(cursorPushedBranch(undefined)).toBeNull()
    expect(cursorLinks('bc-123')).toEqual({
      webUrl: 'https://cursor.com/agents/bc-123',
      desktopUrl: 'cursor://anysphere.cursor-deeplink/background-agent?bcId=bc-123',
    })
  })

  it('keeps a session attached to a pull request across snapshot saves', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-cursor-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const pullRequest = { key: 'acme/app#1', title: 'One' } as PullRequest
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:00:00Z',
      pullRequests: [pullRequest],
      linearConfigured: false,
      warning: null,
    })
    db.saveCursorSession('acme/app#1', {
      agentId: 'bc-123',
      runId: 'run-1',
      status: 'running',
      result: null,
      branch: null,
      updatedAt: '2026-10-21T00:01:00Z',
    })

    expect(db.snapshot().pullRequests[0]?.cursorSession).toMatchObject({ agentId: 'bc-123', status: 'running' })

    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:02:00Z',
      pullRequests: [pullRequest],
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().pullRequests[0]?.cursorSession?.status).toBe('running')

    const review = { key: 'acme/app#2', title: 'Theirs', author: 'ada' } as PullRequest
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:03:00Z',
      pullRequests: [pullRequest],
      reviewPullRequests: [review],
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().reviewPullRequests.map((item) => item.key)).toEqual(['acme/app#2'])
    db.saveSnapshot({
      viewer: 'k',
      syncedAt: '2026-10-21T00:04:00Z',
      pullRequests: [pullRequest],
      linearConfigured: false,
      warning: null,
    })
    expect(db.snapshot().reviewPullRequests.map((item) => item.key)).toEqual(['acme/app#2'])
  })
})
