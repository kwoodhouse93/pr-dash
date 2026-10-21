import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { canMergeSlice, upstackBlock } from '../src/shared/merge.ts'
import { bootAction, interpretWait, rebasesAfter, type LivePull, type MergeStep } from '../src/shared/queue.ts'
import { reviewPolicy } from '../src/shared/rules.ts'
import type { Check, PullRequest } from '../src/shared/types.ts'
import { openDatabase } from '../src/server/db.ts'
import { rebaseOnto } from '../src/server/git.ts'

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

function pr(over: Partial<PullRequest> & Pick<PullRequest, 'id' | 'number' | 'baseRef' | 'headRef'>): PullRequest {
  return {
    key: `acme/app#${over.number}`,
    repo: 'acme/app',
    repoName: 'app',
    title: `PR ${over.number}`,
    url: `https://github.com/acme/app/pull/${over.number}`,
    author: 'ada',
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    committedAt: '2026-10-02T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    defaultBranch: 'main',
    squashMergeAllowed: true,
    requiredApprovals: 1,
    dismissStale: false,
    requiredCheckNames: ['Check'],
    mergeable: 'MERGEABLE',
    mergeStateStatus: over.baseRef === 'main' ? 'CLEAN' : 'CLEAN',
    reviewDecision: over.baseRef === 'main' ? 'APPROVED' : null,
    mergeMark: over.baseRef === 'main' ? 'met' : 'none',
    mergeDetail: '',
    anyApproval: true,
    humanApproval: true,
    changesRequested: false,
    reviewers: [
      { login: 'ada', human: true, state: 'APPROVED', submittedAt: '2026-10-02T01:00:00Z' },
    ],
    conflict: false,
    behind: false,
    checks: [check({ name: 'Check', conclusion: 'SUCCESS', required: true })],
    ci: 'green',
    threadCount: 0,
    unresolvedCount: 0,
    awaitingYouCount: 0,
    threadsTruncated: false,
    linearIssues: [],
    initiativeIds: [],
    ...over,
  }
}

const stack = [
  pr({ id: 'top', number: 3, baseRef: 'middle', headRef: 'top' }),
  pr({ id: 'middle', number: 2, baseRef: 'bottom', headRef: 'middle' }),
  pr({ id: 'bottom', number: 1, baseRef: 'main', headRef: 'bottom', mergeMark: 'met', reviewDecision: 'APPROVED' }),
]

describe('stack merge eligibility', () => {
  it('offers a downstack merge when the chain is ready and skips the trunk pull request', () => {
    expect(canMergeSlice(stack, stack[0]!.key)).toBe(3)
    expect(canMergeSlice(stack, stack[1]!.key)).toBe(2)
    expect(canMergeSlice(stack, stack[2]!.key)).toBeNull()
  })

  it('ignores a running optional check and a ruleset check that never reported', () => {
    const graphite = check({ name: 'Graphite / mergeability_check', conclusion: null, status: 'IN_PROGRESS', completedAt: null })
    const ready = stack.map((item) =>
      item.baseRef === 'main'
        ? item
        : {
            ...item,
            mergeStateStatus: 'UNSTABLE' as const,
            ci: 'green' as const,
            requiredCheckNames: ['Check', 'Check & Fail'],
            checks: [check({ name: 'Check', conclusion: 'SUCCESS', required: true }), graphite],
          },
    )
    expect(canMergeSlice(ready, ready[0]!.key)).toBe(3)
    const blocked = ready.map((item) =>
      item.number === 3 ? { ...item, mergeStateStatus: 'BLOCKED' as const, checks: [graphite] } : item,
    )
    expect(canMergeSlice(blocked, blocked[0]!.key)).toBeNull()
  })

  it('hides the action when an upstack pull request is missing an approval or a required check', () => {
    expect(canMergeSlice(stack.map((item) => (item.number === 3 ? { ...item, reviewers: [] } : item)), stack[0]!.key)).toBeNull()
    expect(
      canMergeSlice(
        stack.map((item) => (item.number === 2 ? { ...item, checks: [check({ name: 'Check', conclusion: 'FAILURE', required: true })], ci: 'red' } : item)),
        stack[0]!.key,
      ),
    ).toBeNull()
    expect(upstackBlock({ ...stack[0]!, threadsTruncated: true }, { requiredApprovals: 1, dismissStale: false })).toMatch(/review threads/)
  })

  it('requires a fresh approval when the ruleset dismisses stale reviews', () => {
    const stale = pr({
      id: 'stale',
      number: 9,
      baseRef: 'bottom',
      headRef: 'stale',
      dismissStale: true,
      committedAt: '2026-10-03T00:00:00Z',
      reviewers: [{ login: 'ada', human: true, state: 'APPROVED', submittedAt: '2026-10-01T00:00:00Z' }],
    })
    expect(upstackBlock(stale, { requiredApprovals: 1, dismissStale: true })).toMatch(/fresh approval/)
  })
})

describe('review policy', () => {
  it('reads the approval count and stale-review rules', () => {
    expect(
      reviewPolicy([
        {
          enforcement: 'active',
          rules: [
            {
              type: 'pull_request',
              parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true },
            },
          ],
        },
        { enforcement: 'disabled', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 9 } }] },
      ]),
    ).toEqual({ requiredApprovals: 2, dismissStale: true })
  })
})

function step(over: Partial<MergeStep> & Pick<MergeStep, 'id' | 'role' | 'headRef' | 'headOid'>): MergeStep {
  return {
    position: 0,
    prKey: over.id,
    number: 1,
    title: over.headRef,
    url: 'https://example.test',
    baseRef: 'main',
    status: 'queued',
    detail: null,
    ...over,
  }
}

describe('rebase plan', () => {
  const steps = [
    step({ id: 'c', role: 'merge', headRef: 'c', headOid: 'c'.repeat(40), position: 0 }),
    step({ id: 'b', role: 'merge', headRef: 'b', headOid: 'b'.repeat(40), position: 1 }),
    step({ id: 'a', role: 'restack', headRef: 'a', headOid: 'a'.repeat(40), position: 2 }),
  ]

  it('keeps the chain stacked while a later pull request still has to merge', () => {
    expect(rebasesAfter(steps, 'c', 'main').map((item) => [item.branch, item.onto, item.finishRestack])).toEqual([
      ['b', 'main', false],
      ['a', 'b', false],
    ])
  })

  it('moves leftover branches onto trunk after the last squash', () => {
    const merged = steps.map((item) => (item.id === 'c' ? { ...item, status: 'merged' as const } : item))
    expect(rebasesAfter(merged, 'b', 'main').map((item) => [item.branch, item.onto, item.setBaseTo, item.cutoffOid])).toEqual([
      ['a', 'main', 'main', 'b'.repeat(40)],
    ])
  })
})

function live(over: Partial<LivePull> = {}): LivePull {
  return {
    number: 4,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    baseRef: 'main',
    headRef: 'feature',
    headOid: 'a'.repeat(40),
    unresolvedCount: 0,
    threadsTruncated: false,
    committedAt: null,
    reviewers: [],
    changesRequested: false,
    checks: [check({ name: 'Check', conclusion: 'SUCCESS', required: true })],
    ...over,
  }
}

describe('wait decisions', () => {
  it('merges a clean pull request and waits for checks that have not finished', () => {
    expect(interpretWait(live(), 'main', ['Check']).action).toBe('ready')
    expect(interpretWait(live({ checks: [] }), 'main', ['Check'])).toMatchObject({ action: 'wait' })
    expect(
      interpretWait(
        live({
          mergeStateStatus: 'UNSTABLE',
          checks: [
            check({ name: 'Check', conclusion: 'SUCCESS', required: true }),
            check({ name: 'Graphite / mergeability_check', conclusion: null, status: 'IN_PROGRESS', completedAt: null }),
          ],
        }),
        'main',
        ['Check', 'Check & Fail'],
      ).action,
    ).toBe('ready')
    expect(
      interpretWait(
        live({
          checks: [check({ name: 'Check', conclusion: null, status: 'IN_PROGRESS', required: true, completedAt: null })],
        }),
        'main',
        ['Check'],
      ).action,
    ).toBe('wait')
    expect(interpretWait(live({ mergeStateStatus: 'BEHIND' }), 'main', ['Check'])).toMatchObject({ action: 'behind' })
  })

  it('stops on conflicts, missing reviews, and failed required checks', () => {
    expect(interpretWait(live({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'main', ['Check']).action).toBe('fail')
    expect(interpretWait(live({ reviewDecision: 'REVIEW_REQUIRED' }), 'main', ['Check']).action).toBe('fail')
    expect(
      interpretWait(live({ checks: [check({ name: 'Check', conclusion: 'FAILURE', required: true })] }), 'main', ['Check']).action,
    ).toBe('fail')
  })
})

describe('restart', () => {
  it('resumes a wait and pauses a rebase or an in-flight merge', () => {
    expect(bootAction('waiting', 'OPEN').type).toBe('resume')
    expect(bootAction('rebasing', 'unknown')).toMatchObject({ type: 'pause', merged: false })
    expect(bootAction('merging', 'MERGED')).toMatchObject({ type: 'pause', merged: true })
    expect(bootAction('merging', 'OPEN')).toMatchObject({ type: 'pause', merged: false })
  })
})

describe('queue store', () => {
  it('pauses on failure and resumes when that entry is removed or cancelled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-queue-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const first = db.queue.enqueue({
      kind: 'stack',
      repo: 'acme/app',
      trunk: 'main',
      title: 'First',
      steps: [{ prKey: 'acme/app#1', number: 1, title: 'First', url: 'https://example.test', headRef: 'a', headOid: 'a'.repeat(40), baseRef: 'main', role: 'merge' }],
    })
    const second = db.queue.enqueue({
      kind: 'pr',
      repo: 'acme/app',
      trunk: 'main',
      title: 'Second',
      steps: [{ prKey: 'acme/app#2', number: 2, title: 'Second', url: 'https://example.test', headRef: 'b', headOid: 'b'.repeat(40), baseRef: 'main', role: 'merge' }],
    })
    db.queue.fail(first.id, first.steps[0]!.id, 'Check failed.')
    expect(db.queue.isPaused()).toBe(true)
    expect(db.queue.nextRunnable()).toBeNull()
    db.queue.remove(first.id)
    expect(db.queue.isPaused()).toBe(false)
    expect(db.queue.nextRunnable()?.id).toBe(second.id)

    db.queue.fail(second.id, second.steps[0]!.id, 'Conflict.')
    expect(db.queue.requestCancel(second.id)).toBe('now')
    expect(db.queue.isPaused()).toBe(false)
    expect(db.queue.snapshot().entries).toEqual([])
    expect(db.queue.snapshot().history.map((entry) => entry.status).sort()).toEqual(['cancelled', 'failed'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('reorders queued entries and leaves the active one in front', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-queue-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const active = db.queue.enqueue(entry('Active', 1))
    const lower = db.queue.enqueue(entry('Lower', 2))
    const upper = db.queue.enqueue(entry('Upper', 3))
    db.queue.markActive(active.id)
    db.queue.move(upper.id, 'up')
    expect(db.queue.snapshot().entries.map((item) => item.title)).toEqual(['Active', 'Upper', 'Lower'])
    expect(() => db.queue.move(active.id, 'down')).toThrow(/queued/)
    expect(db.queue.nextRunnable()?.id).toBe(active.id)
    expect(lower.id).not.toBe(upper.id)
    rmSync(dir, { recursive: true, force: true })
  })
})

function entry(title: string, number: number) {
  return {
    kind: 'pr' as const,
    repo: 'acme/app',
    trunk: 'main',
    title,
    steps: [
      {
        prKey: `acme/app#${number}`,
        number,
        title,
        url: 'https://example.test',
        headRef: `branch-${number}`,
        headOid: number.toString(16).padStart(40, 'a'),
        baseRef: 'main',
        role: 'merge' as const,
      },
    ],
  }
}

describe('git rebase', () => {
  it('puts a child branch onto trunk and does not push a conflict', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pr-dash-git-'))
    const origin = path.join(root, 'origin.git')
    const work = path.join(root, 'work')
    git(['init', '--bare', '-b', 'main', origin])
    git(['clone', origin, work])
    git(['config', 'user.email', 'test@example.com'], work)
    git(['config', 'user.name', 'Test'], work)
    write(work, 'file.txt', 'one\n')
    git(['add', 'file.txt'], work)
    git(['commit', '-m', 'trunk'], work)
    git(['push', 'origin', 'HEAD:main'], work)
    git(['checkout', '-b', 'parent'], work)
    write(work, 'parent.txt', 'parent\n')
    git(['add', 'parent.txt'], work)
    git(['commit', '-m', 'parent'], work)
    const parent = git(['rev-parse', 'HEAD'], work)
    git(['push', 'origin', 'HEAD:parent'], work)
    git(['checkout', '-b', 'child'], work)
    write(work, 'child.txt', 'child\n')
    git(['add', 'child.txt'], work)
    git(['commit', '-m', 'child'], work)
    const child = git(['rev-parse', 'HEAD'], work)
    git(['push', 'origin', 'HEAD:child'], work)

    const rebased = await rebaseOnto({
      mirror: path.join(root, 'mirror.git'),
      remote: origin,
      token: null,
      trunk: 'main',
      branch: 'child',
      cutoffOid: parent,
      expectedOid: child,
    })
    git(['fetch', 'origin'], work)
    expect(git(['rev-parse', 'origin/child'], work)).toBe(rebased)
    expect(git(['diff', '--name-only', 'origin/main', 'origin/child'], work).split('\n').filter(Boolean)).toEqual(['child.txt'])

    git(['checkout', 'main'], work)
    write(work, 'child.txt', 'trunk\n')
    git(['add', 'child.txt'], work)
    git(['commit', '-m', 'trunk child'], work)
    git(['push', 'origin', 'HEAD:main'], work)
    git(['checkout', 'child'], work)
    git(['reset', '--hard', 'origin/child'], work)
    write(work, 'child.txt', 'child-again\n')
    git(['add', 'child.txt'], work)
    git(['commit', '-m', 'conflict'], work)
    const conflicted = git(['rev-parse', 'HEAD'], work)
    git(['push', 'origin', 'HEAD:child'], work)
    await expect(
      rebaseOnto({
        mirror: path.join(root, 'mirror.git'),
        remote: origin,
        token: null,
        trunk: 'main',
        branch: 'child',
        cutoffOid: rebased,
        expectedOid: conflicted,
      }),
    ).rejects.toThrow()
    git(['fetch', 'origin'], work)
    expect(git(['rev-parse', 'origin/child'], work)).toBe(conflicted)
    rmSync(root, { recursive: true, force: true })
  })
})

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(dir: string, name: string, contents: string) {
  writeFileSync(path.join(dir, name), contents)
}
