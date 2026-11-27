import type { GraphqlView } from './budget.ts'
import type { Snapshot } from './types.ts'

// What the server says about its refreshes, and the page reads.

export type SyncKind = 'full' | 'rules' | 'list' | 'pull' | 'threads'
export type UserSyncKind = 'full' | 'rules'
export type SyncOutcome = 'done' | 'failed' | 'cancelled'

/** The code on the refusal a cancelled refresh ends with. It is not a failure, so the page says nothing. */
export const SYNC_CANCELLED = 'sync-cancelled'

export type SyncJob = {
  id: string
  kind: SyncKind
}

export type SyncHistoryEntry = {
  id: string
  kind: UserSyncKind
  outcome: SyncOutcome
  message: string
  startedAt: string | null
  finishedAt: string
}

export type SyncStatus = {
  running: boolean
  message: string
  completed: number
  total: number
  activity: SyncJob | null
  queue: SyncJob[]
  history: SyncHistoryEntry[]
  graphql: GraphqlView
  rules: { repo: string; fetchedAt: string }[]
}

export type FeedbackLoad = {
  snapshot: Snapshot
  pending: number
  paused: boolean
}
