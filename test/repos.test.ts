import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mirrorPath, removeMirror } from '../src/server/git.ts'
import { openDatabase } from '../src/server/db.ts'
import {
  authoredSearchQueries,
  ownersFromRepos,
  parseRepoName,
  removalWarning,
  replaceRepoPulls,
  scopedQueries,
} from '../src/shared/repos.ts'
import type { PullRequest } from '../src/shared/types.ts'

function pr(repo: string, number: number): PullRequest {
  return { key: `${repo}#${number}`, repo, repoName: repo.split('/')[1] ?? repo, number } as PullRequest
}

describe('repository selection', () => {
  it('groups repositories under their owner and puts the signed-in user first', () => {
    const owners = ownersFromRepos(
      [
        { name: 'initech/backend', selected: true, stored: true },
        { name: 'initech/frontend', selected: false, stored: true },
        { name: 'ada/notes', selected: false, stored: false },
        { name: 'globex/ledger', selected: true, stored: true },
      ],
      'ada',
    )
    expect(owners.map((owner) => owner.name)).toEqual(['ada', 'globex', 'initech'])
    expect(owners.find((owner) => owner.name === 'initech')).toMatchObject({ selected: 1, stored: 1, total: 2 })
  })

  it('parses owner/name and rejects anything else', () => {
    expect(parseRepoName(' Gobonoid/cbc-paymentology-notifications ')).toBe('Gobonoid/cbc-paymentology-notifications')
    expect(() => parseRepoName('cbc-paymentology-notifications')).toThrow(/owner\/name/)
    expect(() => parseRepoName('owner/../../etc')).toThrow(/owner\/name/)
    expect(() => parseRepoName('owner/name.git')).toThrow(/owner\/name/)
  })

  it('uses repeated repo qualifiers and splits long queries', () => {
    expect(authoredSearchQueries([])).toEqual([])
    expect(authoredSearchQueries(['acme/web', 'acme/app'])).toEqual([
      'sort:updated-desc is:open is:pr archived:false author:@me repo:acme/app repo:acme/web',
    ])
    const repos = Array.from({ length: 20 }, (_, index) => `acme/repository-name-${String(index).padStart(2, '0')}`)
    const queries = scopedQueries('is:open is:pr', repos)
    expect(queries.length).toBeGreaterThan(1)
    expect(queries.every((query) => query.length <= 256)).toBe(true)
    expect(queries.flatMap((query) => query.match(/repo:[^ ]+/g) ?? [])).toHaveLength(20)
    expect(queries.every((query) => !query.includes(' OR '))).toBe(true)
    expect(scopedQueries('x'.repeat(250), ['acme/app', 'acme/web'])).toEqual([])
  })

  it('replaces pull requests only for selected repositories', () => {
    const existing = [pr('old/one', 1), pr('keep/two', 2)]
    const fetched = [pr('old/one', 3)]
    expect(replaceRepoPulls(existing, fetched, ['old/one']).map((item) => item.key)).toEqual(['keep/two#2', 'old/one#3'])
    expect(replaceRepoPulls(existing, [], []).map((item) => item.key)).toEqual(['old/one#1', 'keep/two#2'])
  })

  it('warns that removal deletes stored data', () => {
    expect(removalWarning('acme/app', true, false).body).toMatch(/deletes pull requests/)
    expect(removalWarning('acme/app', true, false).confirm).toBe('Remove repository')
    expect(removalWarning('acme/app', false, false).body).toMatch(/Nothing is stored/)
    expect(removalWarning('acme/app', true, true).confirm).toBeNull()
  })
})

describe('forgetting a repository', () => {
  const dirs: string[] = []
  const previousDatabase = process.env.DATABASE_PATH

  afterEach(() => {
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH
    else process.env.DATABASE_PATH = previousDatabase
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function database() {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-repos-'))
    dirs.push(dir)
    process.env.DATABASE_PATH = path.join(dir, 'dash.sqlite')
    return openDatabase(process.env.DATABASE_PATH)
  }

  it('starts with no repositories selected', () => {
    const db = database()
    expect(db.watchedRepos()).toEqual([])
    expect(db.snapshot().repos).toEqual([])
  })

  it('deletes stored pull requests, rules, sessions, assignments, and queue entries', () => {
    const db = database()
    db.watchRepo('acme/app')
    db.watchRepo('keep/other')
    db.saveRules('acme/app', { checks: ['ci'], requiredApprovals: 1, dismissStale: false }, '2026-10-21T00:00:00Z')
    db.saveRules('keep/other', { checks: ['ci'], requiredApprovals: 0, dismissStale: false }, '2026-10-21T00:00:00Z')
    const initiative = db.createInitiative('Cleanup')
    db.saveSnapshot({
      viewer: 'ada',
      syncedAt: '2026-10-21T00:00:00Z',
      pullRequests: [pr('acme/app', 1), pr('keep/other', 2)],
      reviewPullRequests: [pr('acme/app', 3)],
      linearConfigured: false,
      warning: null,
    })
    db.setAssignments(initiative.id, ['acme/app#1', 'keep/other#2'], 'add')
    db.saveCursorSession('acme/app#1', {
      agentId: 'bc-1',
      runId: 'run-1',
      kind: 'prompt',
      prompt: 'Look',
      status: 'finished',
      result: null,
      branch: null,
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    })
    db.saveCursorSession('keep/other#2', {
      agentId: 'bc-2',
      runId: 'run-2',
      kind: 'prompt',
      prompt: 'Stay',
      status: 'finished',
      result: null,
      branch: null,
      createdAt: '2026-10-21T00:00:00Z',
      updatedAt: '2026-10-21T00:00:00Z',
    })
    const entry = db.queue.enqueue({
      kind: 'pr',
      repo: 'acme/app',
      trunk: 'main',
      title: 'Ship',
      steps: [
        {
          prKey: 'acme/app#1',
          number: 1,
          title: 'Ship',
          url: 'https://github.com/acme/app/pull/1',
          headRef: 'ship',
          headOid: 'abc',
          baseRef: 'main',
          role: 'merge',
        },
      ],
    })
    db.queue.retain(entry.id, pr('acme/app', 1))
    db.queue.enqueue({
      kind: 'pr',
      repo: 'keep/other',
      trunk: 'main',
      title: 'Stay',
      steps: [
        {
          prKey: 'keep/other#2',
          number: 2,
          title: 'Stay',
          url: 'https://github.com/keep/other/pull/2',
          headRef: 'stay',
          headOid: 'def',
          baseRef: 'main',
          role: 'merge',
        },
      ],
    })

    expect(db.storedRepos()).toEqual(['acme/app', 'keep/other'])
    db.forgetRepo('acme/app')

    const snap = db.snapshot()
    expect(snap.repos).toEqual(['keep/other'])
    expect(snap.pullRequests.map((item) => item.key)).toEqual(['keep/other#2'])
    expect(snap.reviewPullRequests).toEqual([])
    expect(snap.pullRequests[0]?.initiativeIds).toEqual([initiative.id])
    expect(db.ruleCache().map((rule) => rule.repo)).toEqual(['keep/other'])
    expect(db.cursorSessions().map((item) => item.prKey)).toEqual(['keep/other#2'])
    expect(db.queue.snapshot().entries.map((item) => item.repo)).toEqual(['keep/other'])
    expect(db.storedRepos()).toEqual(['keep/other'])
  })

  it('keeps a linked Linear issue after a refresh replaces the pull request', () => {
    const db = database()
    const issue = {
      identifier: 'eng-12',
      title: 'Login',
      url: 'https://linear.app/acme/issue/ENG-12',
      projectId: 'p1',
      projectName: 'Updates',
      teamId: 'team',
      status: { id: 's1', name: 'Todo', type: 'unstarted', color: '#ccc' },
      assignee: null,
    }
    db.saveSnapshot({
      viewer: 'ada',
      syncedAt: '2026-10-21T00:00:00Z',
      pullRequests: [{ ...pr('acme/app', 4), linearIssues: [] }],
      linearConfigured: true,
      warning: null,
    })
    const linked = db.attachLinearIssue('acme/app#4', issue)
    expect(linked.pullRequests[0]?.linearIssues.map((item) => item.identifier)).toEqual(['ENG-12'])
    expect(linked.pullRequests[0]?.linearIssues[0]?.title).toBe('Login')
    db.saveSnapshot({
      viewer: 'ada',
      syncedAt: '2026-10-21T00:01:00Z',
      pullRequests: [{ ...pr('acme/app', 4), linearIssues: [] }],
      linearConfigured: true,
      warning: null,
    })
    expect(db.snapshot().pullRequests[0]?.linearIssues.map((item) => item.identifier)).toEqual(['ENG-12'])
    db.forgetRepo('acme/app')
    expect(db.linearLinks().size).toBe(0)
  })

  it('refuses to remove a repository with a merge in progress', () => {
    const db = database()
    db.watchRepo('acme/app')
    const entry = db.queue.enqueue({
      kind: 'pr',
      repo: 'acme/app',
      trunk: 'main',
      title: 'Ship',
      steps: [
        {
          prKey: 'acme/app#1',
          number: 1,
          title: 'Ship',
          url: 'https://github.com/acme/app/pull/1',
          headRef: 'ship',
          headOid: 'abc',
          baseRef: 'main',
          role: 'merge',
        },
      ],
    })
    db.queue.markActive(entry.id)
    expect(() => db.forgetRepo('acme/app')).toThrow(/merge is in progress/)
    expect(db.watchedRepos()).toEqual(['acme/app'])
  })

  it('deletes the local mirror and refuses a path outside the mirrors directory', async () => {
    database()
    const mirror = mirrorPath('acme/app')
    mkdirSync(mirror, { recursive: true })
    writeFileSync(path.join(mirror, 'HEAD'), 'ref: refs/heads/main')
    await removeMirror('acme/app')
    expect(existsSync(mirror)).toBe(false)
    await expect(removeMirror('acme/../../outside')).rejects.toThrow(/outside the mirrors directory/)
  })
})
