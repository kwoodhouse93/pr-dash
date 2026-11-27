import { isBehindBase, type ShadowedRun } from './map.ts'
import { awaitingApproval, mergeStateReady, requiredCheckGate } from './merge.ts'
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
  /** The head of the branch below this one, as this branch was built on it. Null once it sits on the trunk. */
  baseOid: string | null
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

/** `unapproved` is one pull request that merges without its required approval. */
export type EntryKind = 'pr' | 'stack' | 'unapproved'

export type MergeEntry = {
  id: string
  position: number
  kind: EntryKind
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
  /** Commits on the base that the head does not contain. Null when the comparison was not loaded. */
  behindBy: number | null
  unresolvedCount: number
  threadsTruncated: boolean
  committedAt: string | null
  reviewers: Reviewer[]
  changesRequested: boolean
  checks: Check[]
  /** Cancelled workflow runs that GitHub counts in place of an earlier run that passed. */
  shadowed?: ShadowedRun[]
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
  cutoffOid: string
  expectedOid: string
  finishRestack: boolean
}

export type QueueSummary = {
  /** Merges in the queue, whatever their state. */
  count: number
  /** Merges that failed and wait for a retry. */
  held: number
  state: 'active' | 'failed' | 'queued' | 'empty'
  label: string
}

/** What the queue is doing, in the few words a button has room for. */
export function queueSummary(entries: Pick<MergeEntry, 'status'>[]): QueueSummary {
  const count = entries.length
  const held = entries.filter((entry) => entry.status === 'failed').length
  const state = entries.some((entry) => entry.status === 'active') ? 'active' : held > 0 ? 'failed' : count > 0 ? 'queued' : 'empty'
  const detail = {
    failed: `${held} held`,
    active: held > 0 ? `merging, ${held} held` : 'merging',
    queued: 'waiting',
    empty: 'empty',
  }[state]
  return { count, held, state, label: count > 0 ? `Merge queue: ${count} queued, ${detail}` : `Merge queue: ${detail}` }
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
 * The branches that have to move onto the trunk now: each one built directly on a branch that
 * has merged, plus any leftover branch above one of those. A pull request that still has to
 * merge further up is left alone until the one below it has merged, so a merge rewrites one
 * branch and starts CI once, not once for every branch above it.
 * A step's parent is the step whose branch it was based on when it was queued, and the cutoff
 * is that parent's head as the step was built on it, which stays right after the parent is rewritten.
 */
export function rebasesDue(steps: MergeStep[]): RebaseInstruction[] {
  const byHead = new Map(steps.map((step) => [step.headRef, step]))
  const onTrunk = new Set(steps.filter((step) => step.status === 'merged' || step.status === 'restacked').map((step) => step.id))
  const plan: RebaseInstruction[] = []
  for (const step of steps) {
    if (DONE.has(step.status) || step.baseOid == null) continue
    const parent = byHead.get(step.baseRef)
    if (!parent || parent.id === step.id || !onTrunk.has(parent.id)) continue
    plan.push({
      stepId: step.id,
      branch: step.headRef,
      cutoffOid: step.baseOid,
      expectedOid: step.headOid,
      finishRestack: step.role === 'restack',
    })
    if (step.role === 'restack') onTrunk.add(step.id)
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

/**
 * `unapproved` lets a pull request through while its required review is the one thing missing, and carries
 * how many approvals the trunk asks for. GitHub only says such a pull request is blocked, so every other
 * gate here has to hold on its own.
 */
export function interpretWait(
  live: LivePull,
  trunk: string,
  requiredNames: string[],
  unapproved: { requiredApprovals: number } | null = null,
): WaitDecision {
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
  // A review that does not count towards the requirement leaves the decision at "review required".
  if (live.reviewDecision === 'CHANGES_REQUESTED' || (unapproved && live.changesRequested)) {
    return { action: 'fail', reason: `#${live.number} has changes requested.` }
  }
  if (live.reviewDecision === 'REVIEW_REQUIRED' && !unapproved) {
    return { action: 'fail', reason: `#${live.number} is missing a required review.` }
  }
  if (isBehindBase(live.mergeStateStatus, live.behindBy)) return { action: 'behind', headOid: live.headOid }

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
  if (mergeStateReady(live.mergeable, live.mergeStateStatus)) return { action: 'ready' }
  if (unapproved && live.mergeable === 'MERGEABLE' && live.mergeStateStatus === 'BLOCKED' && awaitingApproval(live, unapproved.requiredApprovals)) {
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
  | { type: 'hold'; reason: string; merged: boolean }

/** Decide whether a restart may continue the active entry, or must hold it aside. */
export function bootAction(status: StepStatus, github: 'OPEN' | 'MERGED' | 'CLOSED' | 'unknown'): BootAction {
  if (status === 'waiting' || status === 'queued') return { type: 'resume' }
  if (status === 'rebasing') {
    return {
      type: 'hold',
      merged: false,
      reason: 'Restarted during a rebase. Nothing further was pushed. Restack the remaining branches and retry, or remove this entry.',
    }
  }
  if (status === 'merging' && github === 'MERGED') {
    return {
      type: 'hold',
      merged: true,
      reason: 'Restarted after this pull request merged. The rest of the entry was not rebased. Restack the remaining branches and retry, or remove this entry.',
    }
  }
  if (status === 'merging') {
    return {
      type: 'hold',
      merged: false,
      reason: 'Restarted while a squash merge was in flight. Retry to check whether it landed and carry on, or remove this entry.',
    }
  }
  return {
    type: 'hold',
    merged: false,
    reason: 'Restarted in the middle of this entry. Retry it, or remove it.',
  }
}
