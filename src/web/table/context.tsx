import { createContext, useContext } from 'react'
import { activeHoldNames, type CheckHold, type CiDisplay, displayCi, worstDisplay } from '../../shared/ci.ts'
import type { RowMark } from '../../shared/queue.ts'
import { mergeLineKeys } from '../../shared/stacks.ts'
import type { Initiative, PullRequest, ListName } from '../../shared/types.ts'
import type { StackBlock } from '../../shared/view.ts'

export type StackLock = {
  locked: boolean
  lock: () => boolean
  unlock: () => void
}

export const StackLockContext = createContext<StackLock>({
  locked: false,
  lock: () => false,
  unlock: () => {},
})

export function useStackLock(): StackLock {
  return useContext(StackLockContext)
}

export const COLUMNS = 17

export type IssuePatch = { statusId?: string; assigneeId?: string | null }

/** What every heading, row and control in the table reads: the list being drawn, and what its buttons do. */
export type TableShared = {
  mode: ListName
  initiatives: Initiative[]
  prByKey: Map<string, PullRequest>
  /** False when every pull request in the list is in one repository, so the column would say the same thing on each row. */
  showRepo: boolean
  linearConfigured: boolean
  queueByKey: Map<string, RowMark>
  tones: Map<string, 'a' | 'b'>
  expanded: Set<string>
  collapsed: Set<string>
  /** The sections that list their pull requests without a heading for each issue. */
  flat: ReadonlySet<string>
  onToggle: (id: string) => void
  onToggleSection: (id: string) => void
  onToggleFlat: (id: string) => void
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreateAssigned: (name: string, keys: string[]) => Promise<void>
  onMerge: (key: string) => Promise<void>
  onRetry: (entryId: string) => Promise<void>
  onStackMerge: (key: string) => Promise<void>
  onMarkReady: (key: string) => Promise<void>
  onRerun: (keys: string[], mode: 'failed' | 'all') => Promise<string>
  onRebase: (key: string) => Promise<void>
  onRefreshPr: (key: string) => Promise<void>
  onUpdateIssue: (identifier: string, patch: IssuePatch) => Promise<void>
  onLinkIssue: (key: string, identifier: string) => Promise<void>
}

export const TableContext = createContext<TableShared | null>(null)

export function useTable(): TableShared {
  const table = useContext(TableContext)
  if (!table) throw new Error('A part of the table was drawn outside it.')
  return table
}

export const HoldContext = createContext<Map<string, CheckHold[]>>(new Map())

/** Queues a pull request to merge without its required approval. Null when that is not offered. */
export const UnapprovedMergeContext = createContext<((key: string) => Promise<void>) | null>(null)

export const EMPTY_HOLDS: CheckHold[] = []

/** Pull requests whose state just changed, and the ones that just merged and are on their way off the list. */
export const MotionContext = createContext<{ changed: Map<string, number>; leaving: Set<string> }>({ changed: new Map(), leaving: new Set() })

/** The classes for a row that changed or is leaving. A second change swaps to a twin animation so the wash starts again. */
export function motionClass(keys: string[], motion: { changed: Map<string, number>; leaving: Set<string> }): string {
  if (keys.length > 0 && keys.every((key) => motion.leaving.has(key))) return ' landing'
  const stamp = Math.max(0, ...keys.map((key) => motion.changed.get(key) ?? 0))
  return stamp === 0 ? '' : stamp % 2 === 1 ? ' fresh-a' : ' fresh-b'
}

export function useHolds(): Map<string, CheckHold[]> {
  return useContext(HoldContext)
}

export function shownLevel(prs: PullRequest[], holds: Map<string, CheckHold[]>): CiDisplay {
  return worstDisplay(prs.map((pr) => displayCi(pr.checks, activeHoldNames(pr.checks, holds.get(pr.key) ?? EMPTY_HOLDS))))
}

export function pressedControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, label, .drawer-back, .popover'))
}

/** The stack as merging this pull request sees it: what gets restacked, then it and each one below it. */
export function mergeLineOf(block: StackBlock, key: string, prByKey: Map<string, PullRequest>): PullRequest[] {
  const keys = mergeLineKeys(block.stackKeys, block.parents, key)
  const prs = keys.map((item) => prByKey.get(item)).filter((pr): pr is PullRequest => pr != null)
  return prs.length === keys.length ? prs : []
}
