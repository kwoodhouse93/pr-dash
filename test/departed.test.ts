import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PullRequest } from '../src/shared/types.ts'
import { openDatabase, type DashboardDb } from '../src/server/db.ts'

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `id-${number}`,
    key: `acme/app#${number}`,
    repo: 'acme/app',
    repoName: 'app',
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    author: 'ada',
    linearIssues: [],
    initiativeIds: [],
    ...over,
  } as PullRequest
}

let dir = ''
function open(): DashboardDb {
  dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-departed-'))
  const db = openDatabase(path.join(dir, 'dash.sqlite'))
  db.watchRepo('acme/app')
  return db
}
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function save(db: DashboardDb, mine: PullRequest[], review: PullRequest[] = []) {
  return db.saveSnapshot({ viewer: 'ada', syncedAt: new Date().toISOString(), pullRequests: mine, reviewPullRequests: review, linearConfigured: false, warning: null })
}

describe('departed pull requests', () => {
  it('waits for GitHub before calling a pull request that left the list merged', () => {
    const db = open()
    save(db, [pr(1), pr(2)])
    expect(save(db, [pr(2)]).departed).toEqual([])
    expect(db.pendingDepartures()).toEqual([{ key: 'acme/app#1', repo: 'acme/app', number: 1 }])

    // Only the last 30 days are carried: one that merged long ago is kept, but not sent.
    db.resolveDeparture('acme/app#1', 'merged', '2020-01-01T10:00:00Z')
    expect(db.pendingDepartures()).toEqual([])
    const at = new Date().toISOString()
    save(db, [])
    db.resolveDeparture('acme/app#2', 'closed', at)
    expect(db.snapshot().departed).toMatchObject([{ key: 'acme/app#2', list: 'mine', outcome: 'closed', at, title: 'PR 2' }])
    expect(db.snapshot().departed).toHaveLength(1)
  })

  it('forgets one that left a list while still open', () => {
    const db = open()
    save(db, [], [pr(3)])
    save(db, [], [])
    db.resolveDeparture('acme/app#3', 'open', null)
    expect(db.pendingDepartures()).toEqual([])
    expect(db.snapshot().departed).toEqual([])
  })

  it('drops the record when the pull request is listed again', () => {
    const db = open()
    save(db, [pr(4)])
    save(db, [])
    db.resolveDeparture('acme/app#4', 'closed', new Date().toISOString())
    expect(db.snapshot().departed).toHaveLength(1)
    expect(save(db, [pr(4)]).departed).toEqual([])
  })

  it('records a merge the queue made at once, and keeps its agent sessions', () => {
    const db = open()
    save(db, [pr(5)])
    db.saveAgentSession('acme/app#5', {
      provider: 'cursor', agentId: 'a1', runId: 'r1', kind: 'ci', prompt: null, status: 'finished', result: null, branch: null,
      environmentId: null, url: null, unreachableSince: null, createdAt: '2026-11-20T09:00:00Z', updatedAt: '2026-11-20T09:05:00Z',
    })
    const entry = db.queue.enqueue({
      kind: 'pr', repo: 'acme/app', trunk: 'main', title: 'PR 5',
      steps: [{ prKey: 'acme/app#5', number: 5, title: 'PR 5', url: 'https://example.test', headRef: 'a', headOid: 'a'.repeat(40), baseRef: 'main', baseOid: null, role: 'merge' }],
    })
    db.queue.setStep(entry.steps[0]!.id, 'merged', null)
    const [gone] = db.snapshot().departed!
    expect(gone).toMatchObject({ key: 'acme/app#5', outcome: 'merged', list: 'mine' })
    expect(gone!.agentSessions.map((session) => session.agentId)).toEqual(['a1'])
    // The refresh that then drops it from the list leaves the record as it is.
    expect(save(db, []).departed).toHaveLength(1)
    expect(db.pendingDepartures()).toEqual([])
  })

  it('ignores a repository that is no longer synced, and forgets with the repository', () => {
    const db = open()
    save(db, [pr(6), pr(7, { repo: 'acme/other', key: 'acme/other#7' })])
    save(db, [])
    expect(db.pendingDepartures().map((item) => item.key)).toEqual(['acme/app#6'])
    db.forgetRepo('acme/app')
    expect(db.pendingDepartures()).toEqual([])
  })

  it('keeps every merge of yours and every review you submit for the activity page', () => {
    const db = open()
    const ready = '2026-11-20T09:00:00.000Z'
    save(db, [pr(1, { readyAt: ready })], [pr(5, { viewerReviewedAt: '2026-11-21T10:00:00.000Z', readyAt: ready }), pr(6)])
    // The same review is logged once however many refreshes see it; a second review is another entry.
    save(db, [pr(1, { readyAt: ready })], [pr(5, { viewerReviewedAt: '2026-11-21T10:00:00.000Z', readyAt: ready }), pr(6)])
    save(db, [], [pr(5, { viewerReviewedAt: '2026-11-22T10:00:00.000Z', readyAt: ready })])
    db.resolveDeparture('acme/app#1', 'merged', '2026-11-22T12:00:00.000Z')
    db.resolveDeparture('acme/app#6', 'merged', '2026-11-22T12:00:00.000Z')

    const activity = db.activity()
    expect(activity.merged).toEqual([
      { key: 'acme/app#1', repo: 'acme/app', repoName: 'app', number: 1, title: 'PR 1', url: 'https://github.com/acme/app/pull/1', at: '2026-11-22T12:00:00.000Z', readyAt: ready },
    ])
    expect(activity.reviewed.map((event) => [event.key, event.at, event.readyAt])).toEqual([
      ['acme/app#5', '2026-11-21T10:00:00.000Z', ready],
      ['acme/app#5', '2026-11-22T10:00:00.000Z', ready],
    ])

    db.forgetRepo('acme/app')
    expect(db.activity()).toEqual({ merged: [], reviewed: [] })
  })
})
