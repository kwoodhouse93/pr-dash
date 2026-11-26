import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { canMergeSlice, unapprovedMergeBlock, upstackBlock } from '../src/shared/merge.ts'
import { bootAction, cancelGrace, interpretWait, landedMergeVisible, queueSummary, rebasesDue, CANCEL_GRACE_MS, type LivePull, type MergeStep } from '../src/shared/queue.ts'
import { reviewBypassBlock, reviewPolicy } from '../src/shared/rules.ts'
import type { Check, PullRequest } from '../src/shared/types.ts'
import { openDatabase } from '../src/server/db.ts'
import { rebaseOnto, rebaseOntoTip } from '../src/server/git.ts'

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
    authorAvatarUrl: null,
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

  it('offers the merge when an upstack pull request is behind its base, but not when it conflicts', () => {
    const behind = stack.map((item) => (item.number === 2 ? { ...item, behind: true } : item))
    expect(canMergeSlice(behind, behind[0]!.key)).toBe(3)
    const conflicting = stack.map((item) => (item.number === 2 ? { ...item, behind: true, conflict: true } : item))
    expect(canMergeSlice(conflicting, conflicting[0]!.key)).toBeNull()
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

describe('merging without approval', () => {
  const waiting = (over: Partial<PullRequest> = {}) =>
    pr({ id: 'a', number: 1, baseRef: 'main', headRef: 'a', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', reviewers: [], ...over })

  it('is allowed when the approval is the only thing missing', () => {
    expect(unapprovedMergeBlock(waiting())).toBeNull()
  })

  it('is allowed when GitHub blocks the pull request without giving a review decision', () => {
    expect(unapprovedMergeBlock(waiting({ reviewDecision: null }))).toBeNull()
    const approved = [{ login: 'ada', human: true, state: 'APPROVED' as const, submittedAt: '2026-10-02T01:00:00Z' }]
    expect(unapprovedMergeBlock(waiting({ reviewDecision: null, reviewers: approved }))).toMatch(/not waiting on an approval/)
    expect(unapprovedMergeBlock(waiting({ reviewDecision: null, reviewers: approved, requiredApprovals: 2 }))).toBeNull()
    expect(unapprovedMergeBlock(waiting({ reviewDecision: null, requiredApprovals: 0 }))).toMatch(/not waiting on an approval/)
    expect(interpretWait(live({ mergeStateStatus: 'BLOCKED', reviewDecision: null, behindBy: 0 }), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('ready')
    expect(interpretWait(live({ mergeStateStatus: 'BLOCKED', reviewDecision: null, behindBy: 0 }), 'main', ['Check'], { requiredApprovals: 0 })).toMatchObject({ action: 'wait', unexplained: true })
  })

  it('is refused for anything else that is not in place', () => {
    expect(unapprovedMergeBlock(waiting({ reviewDecision: 'APPROVED' }))).toMatch(/not waiting on an approval/)
    expect(unapprovedMergeBlock(waiting({ mergeStateStatus: 'CLEAN' }))).toMatch(/not waiting on an approval/)
    expect(unapprovedMergeBlock(waiting({ baseRef: 'below' }))).toMatch(/does not target main/)
    expect(unapprovedMergeBlock(waiting({ isDraft: true }))).toMatch(/draft/)
    expect(unapprovedMergeBlock(waiting({ conflict: true }))).toMatch(/conflict/)
    expect(unapprovedMergeBlock(waiting({ unresolvedCount: 1 }))).toMatch(/unresolved/)
    expect(unapprovedMergeBlock(waiting({ changesRequested: true }))).toMatch(/changes requested/)
    expect(unapprovedMergeBlock(waiting({ checks: [check({ name: 'Check', conclusion: 'FAILURE', required: true })] }))).toMatch(/failing/)
    expect(unapprovedMergeBlock(waiting({ checks: [check({ name: 'Check', conclusion: null, status: 'IN_PROGRESS', required: true })] }))).toMatch(/waiting on required checks/)
    // GitHub blocks the pull request, so a required check that never reported cannot be waved through.
    expect(unapprovedMergeBlock(waiting({ checks: [check({ name: 'Other', conclusion: 'SUCCESS' })] }))).toMatch(/waiting on required checks/)
  })

  const review = (bypass: string, extra: { type: string }[] = []) => ({
    name: 'require review',
    enforcement: 'active',
    current_user_can_bypass: bypass,
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }, ...extra],
  })

  it('needs a review ruleset the viewer may bypass', () => {
    expect(reviewBypassBlock([review('pull_requests_only')])).toBeNull()
    expect(reviewBypassBlock([review('always'), { enforcement: 'active', current_user_can_bypass: 'never', rules: [{ type: 'deletion' }] }])).toBeNull()
    expect(reviewBypassBlock([review('never')])).toMatch(/not allowed to bypass the ruleset "require review"/)
    expect(reviewBypassBlock([review('always'), review('never')])).toMatch(/not allowed/)
    expect(reviewBypassBlock([])).toMatch(/no review rule to bypass/)
    expect(reviewBypassBlock([{ ...review('always'), enforcement: 'disabled' }])).toMatch(/no review rule to bypass/)
  })

  it('counts path reviewers and code owners as reviews', () => {
    const paths = {
      enforcement: 'active',
      current_user_can_bypass: 'never',
      rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0, required_reviewers: [{}] } }],
    }
    expect(reviewBypassBlock([review('always'), paths])).toMatch(/not allowed/)
  })

  it('is refused when the bypass would skip a rule the queue does not check', () => {
    expect(reviewBypassBlock([review('always', [{ type: 'required_deployments' }])])).toMatch(/required_deployments/)
    expect(reviewBypassBlock([review('always'), { enforcement: 'active', current_user_can_bypass: 'always', rules: [{ type: 'code_scanning' }] }])).toMatch(/code_scanning/)
    // GitHub still enforces a ruleset the viewer cannot bypass.
    expect(reviewBypassBlock([review('always'), { enforcement: 'active', current_user_can_bypass: 'never', rules: [{ type: 'code_scanning' }] }])).toBeNull()
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
    baseOid: null,
    status: 'queued',
    detail: null,
    ...over,
  }
}

describe('rebase plan', () => {
  // main ← c ← b ← a      merging c then b, a sits above b
  const oid = (letter: string) => letter.repeat(40)
  const steps = [
    step({ id: 'c', role: 'merge', headRef: 'c', headOid: oid('c') }),
    step({ id: 'b', role: 'merge', headRef: 'b', headOid: oid('b'), baseRef: 'c', baseOid: oid('c') }),
    step({ id: 'a', role: 'restack', headRef: 'a', headOid: oid('a'), baseRef: 'b', baseOid: oid('b') }),
  ]
  const shape = (plan: ReturnType<typeof rebasesDue>) =>
    plan.map((item) => [item.branch, item.cutoffOid[0], item.expectedOid[0], item.finishRestack])
  const after = (list: MergeStep[], changes: Record<string, Partial<MergeStep>>) =>
    list.map((item) => ({ ...item, ...changes[item.id] }))

  it('rebases nothing before the first merge', () => {
    expect(rebasesDue(steps)).toEqual([])
  })

  it('moves only the next pull request after a merge, leaving the branch above it alone', () => {
    expect(shape(rebasesDue(after(steps, { c: { status: 'merged' } })))).toEqual([['b', 'c', 'b', false]])
  })

  it('cuts the branch above from the head it was built on, not the head its parent was rewritten to', () => {
    const moved = after(steps, {
      c: { status: 'merged' },
      b: { status: 'merged', headOid: oid('9'), baseOid: null },
    })
    expect(shape(rebasesDue(moved))).toEqual([['a', 'b', 'a', true]])
  })

  it('does not move a branch that already sits on the trunk', () => {
    expect(rebasesDue(after(steps, { c: { status: 'merged' }, b: { baseOid: null } }))).toEqual([])
  })
})

describe('rebase plan for a stack with branches', () => {
  // main ← r ← f ← x      merging r, f and then x
  //            ↖ s ← t    s and t are a second branch off f
  //        x ← y          y sits above x
  const oid = (letter: string) => letter.repeat(40)
  const steps = [
    step({ id: 'r', role: 'merge', headRef: 'r', headOid: oid('1'), baseRef: 'main', status: 'merged' }),
    step({ id: 'f', role: 'merge', headRef: 'f', headOid: oid('2'), baseRef: 'r', baseOid: oid('1') }),
    step({ id: 'x', role: 'merge', headRef: 'x', headOid: oid('3'), baseRef: 'f', baseOid: oid('2') }),
    step({ id: 's', role: 'restack', headRef: 's', headOid: oid('4'), baseRef: 'f', baseOid: oid('2') }),
    step({ id: 't', role: 'restack', headRef: 't', headOid: oid('5'), baseRef: 's', baseOid: oid('4') }),
    step({ id: 'y', role: 'restack', headRef: 'y', headOid: oid('6'), baseRef: 'x', baseOid: oid('3') }),
  ]
  const shape = (plan: ReturnType<typeof rebasesDue>) => plan.map((item) => [item.branch, item.cutoffOid[0], item.finishRestack])

  it('moves only the branch on the merged one while pull requests above it still have to merge', () => {
    expect(shape(rebasesDue(steps))).toEqual([['f', '1', false]])
  })

  it('moves a side branch and what sits on it once their parent has merged, and leaves the merging branch above alone', () => {
    const merged = steps.map((item) => (item.id === 'f' ? { ...item, status: 'merged' as const, baseOid: null } : item))
    expect(shape(rebasesDue(merged))).toEqual([
      ['x', '2', false],
      ['s', '2', true],
      ['t', '4', true],
    ])
  })

  it('finishes with only what sits above the last merge', () => {
    const done = steps.map((item) =>
      item.id === 'f' || item.id === 'x'
        ? { ...item, status: 'merged' as const, baseOid: null }
        : item.id === 's' || item.id === 't'
          ? { ...item, status: 'restacked' as const, baseOid: null }
          : item,
    )
    expect(shape(rebasesDue(done))).toEqual([['y', '3', true]])
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
    behindBy: null,
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
  it('lets an entry queued without approval through when the review is all that blocks it', () => {
    const blocked = (over: Partial<LivePull> = {}) => live({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', behindBy: 0, ...over })
    expect(interpretWait(blocked(), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('ready')
    expect(interpretWait(blocked({ changesRequested: true }), 'main', ['Check'], { requiredApprovals: 1 })).toMatchObject({ action: 'fail', reason: '#4 has changes requested.' })
    expect(interpretWait(blocked({ unresolvedCount: 1 }), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('fail')
    expect(interpretWait(blocked({ behindBy: 2 }), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('behind')
    expect(interpretWait(blocked({ checks: [check({ name: 'Check', conclusion: 'FAILURE', required: true })] }), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('fail')
    expect(interpretWait(blocked({ checks: [check({ name: 'Other', conclusion: 'SUCCESS' })] }), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('wait')
    // Approved since it was queued, so whatever still blocks it is not the review.
    expect(interpretWait(blocked({ reviewDecision: 'APPROVED' }), 'main', ['Check'], { requiredApprovals: 1 })).toMatchObject({ action: 'wait', unexplained: true })
    expect(interpretWait(live(), 'main', ['Check'], { requiredApprovals: 1 }).action).toBe('ready')
  })

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
    expect(interpretWait(live({ mergeStateStatus: 'BLOCKED', behindBy: 4 }), 'main', ['Check'])).toMatchObject({ action: 'behind' })
    expect(interpretWait(live({ mergeStateStatus: 'CLEAN', behindBy: 1 }), 'main', ['Check'])).toMatchObject({ action: 'behind' })
    expect(interpretWait(live({ mergeStateStatus: 'BLOCKED', behindBy: 0 }), 'main', ['Check'])).toMatchObject({ action: 'wait' })
  })

  it('waits when a required check was cancelled so a replacement run can start', () => {
    const decision = interpretWait(
      live({ checks: [check({ name: 'Run', conclusion: 'CANCELLED', required: true })] }),
      'main',
      ['Run'],
    )
    expect(decision).toMatchObject({ action: 'wait', restarting: ['Run'] })
    expect(interpretWait(live({ checks: [check({ name: 'Run', conclusion: 'FAILURE', required: true })] }), 'main', ['Run']).action).toBe('fail')
    expect(cancelGrace(null, 1_000, true)).toEqual({ since: 1_000, expired: false })
    expect(cancelGrace(1_000, 1_000 + CANCEL_GRACE_MS - 1, true).expired).toBe(false)
    expect(cancelGrace(1_000, 1_000 + CANCEL_GRACE_MS, true).expired).toBe(true)
    expect(cancelGrace(1_000, 1_000 + CANCEL_GRACE_MS, false)).toEqual({ since: null, expired: false })
  })

  it('stops on conflicts, missing reviews, and failed required checks', () => {
    expect(interpretWait(live({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'main', ['Check']).action).toBe('fail')
    expect(interpretWait(live({ reviewDecision: 'REVIEW_REQUIRED' }), 'main', ['Check']).action).toBe('fail')
    expect(interpretWait(live({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), 'main', ['Check']).action).toBe('fail')
    expect(
      interpretWait(live({ checks: [check({ name: 'Check', conclusion: 'FAILURE', required: true })] }), 'main', ['Check']).action,
    ).toBe('fail')
  })
})

describe('landed merge holds', () => {
  it('brings a pull request back only when GitHub still has it open', () => {
    expect(landedMergeVisible('OPEN')).toBe(true)
    expect(landedMergeVisible('MERGED')).toBe(false)
    expect(landedMergeVisible('CLOSED')).toBe(false)
    expect(landedMergeVisible('unknown')).toBe(false)
  })
})

describe('restart', () => {
  it('resumes a wait and holds a rebase or an in-flight merge', () => {
    expect(bootAction('waiting', 'OPEN').type).toBe('resume')
    expect(bootAction('rebasing', 'unknown')).toMatchObject({ type: 'hold', merged: false })
    expect(bootAction('merging', 'MERGED')).toMatchObject({ type: 'hold', merged: true })
    expect(bootAction('merging', 'OPEN')).toMatchObject({ type: 'hold', merged: false })
  })
})

describe('queue store', () => {
  it('persists and updates merge-when-ready watches', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-watch-'))
    const file = path.join(dir, 'dash.sqlite')
    const first = openDatabase(file)
    first.queue.armWatch({
      key: 'acme/app#2',
      scope: 'downstack',
      repo: 'acme/app',
      keys: ['acme/app#2', 'acme/app#1'],
    })
    first.queue.setWatchDetail('acme/app#2', '#1 is missing a required approval.')

    const reopened = openDatabase(file)
    expect(reopened.queue.snapshot().watches).toMatchObject([
      {
        key: 'acme/app#2',
        scope: 'downstack',
        keys: ['acme/app#2', 'acme/app#1'],
        detail: '#1 is missing a required approval.',
      },
    ])
    reopened.queue.disarmWatch('acme/app#2')
    expect(reopened.queue.snapshot().watches).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('holds a failed entry aside, runs the one behind it, and retries it in place', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-queue-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const first = db.queue.enqueue({
      kind: 'stack',
      repo: 'acme/app',
      trunk: 'main',
      title: 'First',
      steps: [{ prKey: 'acme/app#1', number: 1, title: 'First', url: 'https://example.test', headRef: 'a', headOid: 'a'.repeat(40), baseRef: 'main', baseOid: null, role: 'merge' }],
    })
    const second = db.queue.enqueue({
      kind: 'pr',
      repo: 'acme/app',
      trunk: 'main',
      title: 'Second',
      steps: [{ prKey: 'acme/app#2', number: 2, title: 'Second', url: 'https://example.test', headRef: 'b', headOid: 'b'.repeat(40), baseRef: 'main', baseOid: null, role: 'merge' }],
    })
    db.queue.fail(first.id, first.steps[0]!.id, 'Check failed.')
    expect(db.queue.nextRunnable('acme/app')?.id).toBe(second.id)
    expect(db.queue.blocksKey('acme/app#1')).toBe(true)
    expect(() => db.queue.retry(second.id, [])).toThrow(/held/)

    db.queue.retry(first.id, [{ stepId: first.steps[0]!.id, headOid: 'C'.repeat(40), onTrunk: false, restacked: false }])
    const retried = db.queue.get(first.id)!
    expect(retried).toMatchObject({ status: 'queued', error: null, finishedAt: null })
    expect(retried.steps[0]).toMatchObject({ status: 'queued', detail: null, headOid: 'c'.repeat(40) })
    expect(db.queue.nextRunnable('acme/app')?.id).toBe(first.id)

    db.queue.fail(first.id, first.steps[0]!.id, 'Check failed.')
    expect(db.queue.requestCancel(first.id)).toBe('now')
    db.queue.fail(second.id, second.steps[0]!.id, 'Conflict.')
    expect(db.queue.requestCancel(second.id)).toBe('now')
    expect(db.queue.snapshot().entries).toEqual([])
    expect(db.queue.snapshot().history.map((entry) => entry.status).sort()).toEqual(['cancelled', 'cancelled'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('holds a landed pull request off the dashboard unless that merge failed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-hold-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const landed = pr({ id: 'landed', number: 4, baseRef: 'main', headRef: 'landed' })
    const kept = pr({ id: 'kept', number: 5, baseRef: 'main', headRef: 'kept' })
    const queued = db.queue.enqueue({
      kind: 'stack',
      repo: 'acme/app',
      trunk: 'main',
      title: 'Land',
      steps: [
        {
          prKey: landed.key,
          number: landed.number,
          title: landed.title,
          url: landed.url,
          headRef: landed.headRef,
          headOid: 'a'.repeat(40),
          baseRef: 'main',
          baseOid: null,
          role: 'merge',
        },
        {
          prKey: kept.key,
          number: kept.number,
          title: kept.title,
          url: kept.url,
          headRef: kept.headRef,
          headOid: 'b'.repeat(40),
          baseRef: 'main',
          baseOid: null,
          role: 'merge',
        },
      ],
    })
    const save = () =>
      db.saveSnapshot({
        viewer: 'ada',
        syncedAt: '2026-10-21T00:00:00Z',
        pullRequests: [landed, kept],
        reviewPullRequests: [landed],
        linearConfigured: false,
        warning: null,
      })
    save()
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([4, 5])

    const [landedStep, keptStep] = queued.steps
    db.queue.setStep(landedStep!.id, 'merged', null)
    save()
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([5])
    expect(db.snapshot().reviewPullRequests).toEqual([])

    db.queue.releaseHold(landed.key)
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([4, 5])
    db.queue.setStep(landedStep!.id, 'merged', null)
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([5])

    db.queue.setStep(landedStep!.id, 'failed', 'GitHub refused the merge.')
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([4, 5])
    db.queue.setStep(landedStep!.id, 'merged', null)
    db.queue.setStep(keptStep!.id, 'failed', 'The next pull request failed.')
    save()
    expect(db.snapshot().pullRequests.map((item) => item.number)).toEqual([5])
    rmSync(dir, { recursive: true, force: true })
  })

  it('reorders queued entries within a repo, leaves the active one in front, and runs each repo on its own', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-queue-'))
    const db = openDatabase(path.join(dir, 'dash.sqlite'))
    const active = db.queue.enqueue(entry('Active', 1))
    const lower = db.queue.enqueue(entry('Lower', 2))
    const upper = db.queue.enqueue(entry('Upper', 3))
    db.queue.markActive(active.id)
    db.queue.move(upper.id, 'up')
    expect(db.queue.snapshot().entries.map((item) => item.title)).toEqual(['Active', 'Upper', 'Lower'])
    expect(() => db.queue.move(active.id, 'down')).toThrow(/queued/)
    expect(db.queue.nextRunnable('acme/app')?.id).toBe(active.id)
    expect(lower.id).not.toBe(upper.id)

    const other = db.queue.enqueue({ ...entry('Elsewhere', 4), repo: 'acme/web' })
    expect(db.queue.runnableRepos().sort()).toEqual(['acme/app', 'acme/web'])
    expect(db.queue.nextRunnable('acme/web')?.id).toBe(other.id)
    db.queue.move(other.id, 'up')
    expect(db.queue.snapshot().entries.map((item) => item.title)).toEqual(['Active', 'Upper', 'Lower', 'Elsewhere'])
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
        baseOid: null,
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

  it('rebases onto the latest base and restacks the branch above it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pr-dash-tip-'))
    const origin = path.join(root, 'origin.git')
    const work = path.join(root, 'work')
    const mirror = path.join(root, 'mirror.git')
    try {
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

      await expect(
        rebaseOntoTip({ mirror, remote: origin, token: null, base: 'main', branch: 'parent', expectedOid: parent }),
      ).rejects.toThrow('already based on main')
      expect(git(['rev-parse', 'origin/parent'], work)).toBe(parent)

      git(['checkout', 'main'], work)
      write(work, 'file.txt', 'two\n')
      git(['add', 'file.txt'], work)
      git(['commit', '-m', 'trunk again'], work)
      git(['push', 'origin', 'HEAD:main'], work)

      const rebased = await rebaseOntoTip({
        mirror,
        remote: origin,
        token: null,
        base: 'main',
        branch: 'parent',
        expectedOid: parent,
      })
      const restacked = await rebaseOnto({
        mirror,
        remote: origin,
        token: null,
        trunk: 'parent',
        branch: 'child',
        cutoffOid: parent,
        expectedOid: child,
      })
      git(['fetch', 'origin'], work)
      expect(git(['rev-parse', 'origin/parent'], work)).toBe(rebased)
      expect(git(['rev-parse', 'origin/child'], work)).toBe(restacked)
      expect(git(['merge-base', '--is-ancestor', 'origin/main', 'origin/parent'], work)).toBe('')
      expect(git(['merge-base', '--is-ancestor', 'origin/parent', 'origin/child'], work)).toBe('')
      expect(git(['show', 'origin/child:file.txt'], work)).toBe('two')
      expect(git(['diff', '--name-only', 'origin/main', 'origin/parent'], work).split('\n').filter(Boolean)).toEqual(['parent.txt'])
      expect(git(['diff', '--name-only', 'origin/parent', 'origin/child'], work).split('\n').filter(Boolean)).toEqual(['child.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(dir: string, name: string, contents: string) {
  writeFileSync(path.join(dir, name), contents)
}

describe('queueSummary', () => {
  it('says the queue is empty when nothing is in it', () => {
    expect(queueSummary([])).toEqual({ count: 0, held: 0, state: 'empty', label: 'Merge queue: empty' })
  })

  it('counts held merges beside the one running', () => {
    expect(queueSummary([{ status: 'active' }, { status: 'failed' }, { status: 'queued' }])).toEqual({
      count: 3,
      held: 1,
      state: 'active',
      label: 'Merge queue: 3 queued, merging, 1 held',
    })
  })

  it('reads as failed when a held merge is all that is left to act on', () => {
    expect(queueSummary([{ status: 'failed' }, { status: 'queued' }]).state).toBe('failed')
    expect(queueSummary([{ status: 'queued' }]).label).toBe('Merge queue: 1 queued, waiting')
  })
})

describe('queue store upgrade', () => {
  it('records the head each queued branch was built on, from its parent in the same merge', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-upgrade-'))
    const file = path.join(dir, 'dash.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE merge_entries (
        id TEXT PRIMARY KEY, position INTEGER NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, trunk TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, error TEXT, archived INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT
      );
      CREATE TABLE merge_steps (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, position INTEGER NOT NULL, pr_key TEXT NOT NULL,
        number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, head_ref TEXT NOT NULL, head_oid TEXT NOT NULL,
        base_ref TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO merge_entries (id, position, kind, repo, trunk, title, status, created_at, updated_at)
        VALUES ('e', 1, 'stack', 'acme/app', 'main', 'Stack', 'queued', 'now', 'now');
      INSERT INTO merge_steps VALUES
        ('1', 'e', 0, 'acme/app#1', 1, 'One', 'u', 'one', '${'1'.repeat(40)}', 'main', 'merge', 'queued', NULL, 'now'),
        ('2', 'e', 1, 'acme/app#2', 2, 'Two', 'u', 'two', '${'2'.repeat(40)}', 'one', 'merge', 'queued', NULL, 'now'),
        ('3', 'e', 2, 'acme/app#3', 3, 'Three', 'u', 'three', '${'3'.repeat(40)}', 'two', 'restack', 'queued', NULL, 'now');
    `)
    old.close()
    const db = openDatabase(file)
    expect(db.queue.get('e')!.steps.map((item) => item.baseOid)).toEqual([null, '1'.repeat(40), '2'.repeat(40)])
    rmSync(dir, { recursive: true, force: true })
  })
})
