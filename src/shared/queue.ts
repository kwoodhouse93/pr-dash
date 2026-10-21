import { requiredCheckGate } from './merge.ts'
import type { Check, Mergeable, Reviewer } from './types.ts'
import type { ReviewDecision } from './approval.ts'

export type StepStatus =
  | 'queued'
  | 'waiting'
  | 'rebasing'
  | 'merging'
  | 'merged'
  | 'restacked'
  | 'failed'
  | 'cancelled'

export type EntryStatus = 'queued' | 'active' | 'failed' | 'cancelled' | 'done'

export type MergeStep = {
  id: string
  position: number
  prKey: string
  number: number
  title: string
  url: string
  headRef: string
  headOid: string
  baseRef: string
  role: 'merge' | 'restack'
  status: StepStatus
  detail: string | null
}

export type MergeLog = {
  id: number
  at: string
  level: 'info' | 'error'
  message: string
}

export type MergeEntry = {
  id: string
  position: number
  kind: 'pr' | 'stack'
  repo: string
  trunk: string
  title: string
  status: EntryStatus
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  steps: MergeStep[]
  logs: MergeLog[]
}

export type QueueSnapshot = {
  paused: boolean
  pauseReason: string | null
  entries: MergeEntry[]
  history: MergeEntry[]
}

export type RowMark = {
  entryId: string
  entryStatus: EntryStatus
  status: StepStatus
  detail: string | null
  done: number
  total: number
}

export type LivePull = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: Mergeable | null
  mergeStateStatus: string | null
  reviewDecision: ReviewDecision
  baseRef: string
  headRef: string
  headOid: string
  unresolvedCount: number
  threadsTruncated: boolean
  committedAt: string | null
  reviewers: Reviewer[]
  changesRequested: boolean
  checks: Check[]
}

export type WaitDecision =
  | { action: 'ready' }
  | { action: 'wait'; reason: string; unexplained?: boolean; restarting?: string[] }
  | { action: 'behind'; headOid: string }
  | { action: 'merged' }
  | { action: 'fail'; reason: string }

export type RemotePullState = 'OPEN' | 'CLOSED' | 'MERGED' | 'unknown'

/** GitHub's pull request record says the queued merge did not stick. A stale open-list row does not. */
export function landedMergeVisible(state: RemotePullState): boolean {
  return state === 'OPEN'
}

export type RebaseInstruction = {
  stepId: string
  branch: string
  onto: string
  cutoffOid: string
  expectedOid: string
  setBaseTo: string | null
  finishRestack: boolean
}

const DONE: ReadonlySet<StepStatus> = new Set(['merged', 'restacked', 'cancelled'])

export function stepLabel(status: StepStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'waiting':
      return 'Waiting'
    case 'rebasing':
      return 'Rebasing'
    case 'merging':
      return 'Merging'
    case 'merged':
      return 'Merged'
    case 'restacked':
      return 'Rebased'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

export function rowMarks(entries: MergeEntry[]): Map<string, RowMark> {
  const marks = new Map<string, RowMark>()
  for (const entry of entries) {
    const done = entry.steps.filter((step) => step.status === 'merged' || step.status === 'restacked').length
    for (const step of entry.steps) {
      marks.set(step.prKey, {
        entryId: entry.id,
        entryStatus: entry.status,
        status: step.status,
        detail: step.detail ?? entry.error,
        done,
        total: entry.steps.length,
      })
    }
  }
  return marks
}

/**
 * After a squash, rewrite every branch above it, bottom-up.
 * While later pull requests still need to merge, the next one lands on trunk and the
 * ones above it stay stacked on their parent. Once nothing remains to merge, every
 * leftover branch is moved onto trunk so it no longer depends on a merged branch.
 */
export function rebasesAfter(steps: MergeStep[], mergedId: string, trunk: string): RebaseInstruction[] {
  const index = steps.findIndex((step) => step.id === mergedId)
  if (index < 0) return []
  const merged = steps[index]!
  const remaining = steps.slice(index + 1).filter((step) => !DONE.has(step.status))
  const mergeRemaining = remaining.some((step) => step.role === 'merge')
  if (!mergeRemaining) {
    let cutoffOid = merged.headOid
    return remaining.map((step) => {
      const instruction: RebaseInstruction = {
        stepId: step.id,
        branch: step.headRef,
        onto: trunk,
        cutoffOid,
        expectedOid: step.headOid,
        setBaseTo: trunk,
        finishRestack: true,
      }
      cutoffOid = step.headOid
      return instruction
    })
  }
  const plan: RebaseInstruction[] = []
  let onto = trunk
  let cutoffOid = merged.headOid
  for (const step of remaining) {
    plan.push({
      stepId: step.id,
      branch: step.headRef,
      onto,
      cutoffOid,
      expectedOid: step.headOid,
      setBaseTo: onto === trunk ? trunk : null,
      finishRestack: false,
    })
    onto = step.headRef
    cutoffOid = step.headOid
  }
  return plan
}

export const CANCEL_GRACE_MS = 60_000

/** A cancelled required check keeps waiting until a replacement appears, then stops if it never does. */
export function cancelGrace(since: number | null, now: number, restarting: boolean): { since: number | null; expired: boolean } {
  if (!restarting) return { since: null, expired: false }
  const started = since ?? now
  return { since: started, expired: now - started >= CANCEL_GRACE_MS }
}

export function interpretWait(live: LivePull, trunk: string, requiredNames: string[]): WaitDecision {
  if (live.state === 'MERGED') return { action: 'merged' }
  if (live.state === 'CLOSED') return { action: 'fail', reason: `#${live.number} is closed.` }
  if (live.baseRef !== trunk) {
    return { action: 'fail', reason: `#${live.number} targets ${live.baseRef}, not ${trunk}.` }
  }
  if (live.isDraft || live.mergeStateStatus === 'DRAFT') {
    return { action: 'fail', reason: `#${live.number} is still a draft.` }
  }
  if (live.mergeable === 'CONFLICTING' || live.mergeStateStatus === 'DIRTY') {
    return { action: 'fail', reason: `#${live.number} has a merge conflict.` }
  }
  if (live.unresolvedCount > 0) return { action: 'fail', reason: `#${live.number} has unresolved threads.` }
  if (live.threadsTruncated) {
    return { action: 'fail', reason: `#${live.number} has more review threads than this check loaded.` }
  }
  if (live.reviewDecision === 'CHANGES_REQUESTED') {
    return { action: 'fail', reason: `#${live.number} has changes requested.` }
  }
  if (live.reviewDecision === 'REVIEW_REQUIRED') {
    return { action: 'fail', reason: `#${live.number} is missing a required review.` }
  }
  if (live.mergeStateStatus === 'BEHIND') return { action: 'behind', headOid: live.headOid }

  const gate = requiredCheckGate(live.checks, requiredNames, live.mergeable, live.mergeStateStatus)
  if (gate?.action === 'fail') {
    return { action: 'fail', reason: `#${live.number} required check failed: ${gate.names.join(', ')}.` }
  }
  if (gate?.action === 'wait') {
    return {
      action: 'wait',
      reason: gate.restarting
        ? `Waiting for ${gate.names.join(', ')} to restart on #${live.number}.`
        : `Waiting on ${gate.names.join(', ')} for #${live.number}.`,
      restarting: gate.restarting ? gate.names : undefined,
    }
  }
  if (live.mergeable === 'UNKNOWN' || live.mergeStateStatus === 'UNKNOWN' || live.mergeStateStatus == null) {
    return { action: 'wait', reason: `Waiting for GitHub to finish checking #${live.number}.` }
  }
  if (live.mergeable === 'MERGEABLE' && (live.mergeStateStatus === 'CLEAN' || live.mergeStateStatus === 'UNSTABLE' || live.mergeStateStatus === 'HAS_HOOKS')) {
    return { action: 'ready' }
  }
  if (live.mergeStateStatus === 'BLOCKED') {
    return {
      action: 'wait',
      reason: `GitHub is still blocking #${live.number} after checks and reviews passed.`,
      unexplained: true,
    }
  }
  return { action: 'wait', reason: `Waiting on GitHub for #${live.number} (${live.mergeStateStatus ?? 'unknown'}).` }
}

export type BootAction =
  | { type: 'resume' }
  | { type: 'pause'; reason: string; merged: boolean }

/** Decide whether a restart may continue the active entry. */
export function bootAction(status: StepStatus, github: 'OPEN' | 'MERGED' | 'CLOSED' | 'unknown'): BootAction {
  if (status === 'waiting' || status === 'queued') return { type: 'resume' }
  if (status === 'rebasing') {
    return {
      type: 'pause',
      merged: false,
      reason: 'Restarted during a rebase. Nothing further was pushed. Remove or cancel this entry to continue the queue.',
    }
  }
  if (status === 'merging' && github === 'MERGED') {
    return {
      type: 'pause',
      merged: true,
      reason: 'Restarted after this pull request merged. The rest of the entry was not rebased. Remove or cancel it to continue the queue.',
    }
  }
  if (status === 'merging') {
    return {
      type: 'pause',
      merged: false,
      reason: 'Restarted while a squash merge was in flight. It was not retried. Remove or cancel this entry to continue the queue.',
    }
  }
  return {
    type: 'pause',
    merged: false,
    reason: 'Restarted in the middle of this entry. Remove or cancel it to continue the queue.',
  }
}
