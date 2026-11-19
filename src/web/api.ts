import type { AgentRequest } from '../shared/agents.ts'
import type { FeedbackPayload } from '../shared/feedback.ts'
import type { QueueSnapshot } from '../shared/queue.ts'
import type { RepoCatalog } from '../shared/repos.ts'
import type { LinearAssignee, LinearStatus, Snapshot } from '../shared/types.ts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const text = await response.text()
  let body: { error?: string } = {}
  if (text) {
    try {
      body = JSON.parse(text) as { error?: string }
    } catch {
      if (!response.ok) throw new Error(text.slice(0, 240))
      throw new Error('The server returned an unreadable response.')
    }
  }
  if (!response.ok) throw new Error(body.error || response.statusText)
  return body as T
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export type SyncKind = 'full' | 'rules' | 'list' | 'pull' | 'threads'

export type SyncJob = {
  id: string
  kind: SyncKind
}

export type SyncHistoryEntry = {
  id: string
  kind: 'full' | 'rules'
  outcome: 'done' | 'failed' | 'cancelled'
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
  graphql: {
    paused: boolean
    limit: number | null
    remaining: number | null
    resetAt: string | null
    message: string | null
    windows: { limit: number; remaining: number; resetAt: string }[]
  }
  rules: { repo: string; fetchedAt: string }[]
}

export type FeedbackLoad = {
  snapshot: Snapshot
  pending: number
  paused: boolean
}

export const api = {
  snapshot: (focus?: 'mine' | 'review') => request<Snapshot>(focus ? `/api/snapshot?focus=${focus}` : '/api/snapshot'),
  status: () => request<SyncStatus>('/api/status'),
  repos: () => request<RepoCatalog>('/api/repos'),
  addRepo: (repo: string) => post<Snapshot>('/api/repos', { repo }),
  removeRepo: (repo: string) => post<Snapshot>('/api/repos/remove', { repo }),
  refresh: (focus: 'mine' | 'review' = 'mine', full = false, interactive = false) =>
    post<Snapshot>('/api/refresh', { focus, full, interactive }),
  enqueueSync: (kind: 'full' | 'rules', focus: 'mine' | 'review') => post<SyncStatus>('/api/sync', { kind, focus }),
  cancelSync: (id: string) => post<SyncStatus>(`/api/sync/${encodeURIComponent(id)}/cancel`, {}),
  feedback: (focus: 'mine' | 'review') => post<FeedbackLoad>('/api/feedback', { focus }),
  refreshPull: (key: string) => post<Snapshot>('/api/pulls/refresh', { key }),
  markReady: (key: string) => post<Snapshot>('/api/pulls/ready', { key }),
  createInitiative: (name: string) => post<Snapshot>('/api/initiatives', { name }),
  renameInitiative: (id: string, name: string) =>
    request<Snapshot>(`/api/initiatives/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  deleteInitiative: (id: string) => request<Snapshot>(`/api/initiatives/${id}`, { method: 'DELETE' }),
  assign: (initiativeId: string, prKeys: string[], action: 'add' | 'remove') =>
    post<Snapshot>('/api/assignments', { initiativeId, prKeys, action }),
  rerun: (keys: string[], mode: 'failed' | 'all') =>
    post<{ reran: number; errors: string[]; runs: { repo: string; runId: number }[] }>('/api/rerun', { keys, mode }),
  startAgent: (key: string, request: AgentRequest) =>
    post<{ snapshot: Snapshot; agentId: string }>('/api/pulls/agents', { key, ...request }),
  rebase: (key: string) => post<Snapshot>('/api/rebase', { key }),
  merge: (key: string) => post<Snapshot>('/api/merge', { key }),
  mergeQueue: () => request<QueueSnapshot>('/api/merge-queue'),
  enqueue: (key: string, scope: 'pr' | 'downstack') => post<QueueSnapshot>('/api/merge-queue', { key, scope }),
  setMergeWhenReady: (key: string, scope: 'pr' | 'downstack', enabled: boolean) =>
    post<QueueSnapshot>('/api/merge-when-ready', { key, scope, enabled }),
  cancelMerge: (id: string) => post<QueueSnapshot>(`/api/merge-queue/${id}/cancel`, {}),
  retryMerge: (id: string) => post<QueueSnapshot>(`/api/merge-queue/${id}/retry`, {}),
  moveMerge: (id: string, direction: 'up' | 'down') => post<QueueSnapshot>(`/api/merge-queue/${id}/move`, { direction }),
  linearStatuses: (query: { teamId?: string | null; issue: string }) => {
    const key = query.teamId || query.issue
    return cached(statusRequests, key, () => {
      const params = query.teamId
        ? `teamId=${encodeURIComponent(query.teamId)}`
        : `issue=${encodeURIComponent(query.issue)}`
      return request<{ statuses: LinearStatus[] }>(`/api/linear/statuses?${params}`).then((body) => body.statuses)
    })
  },
  linearUsers: () => cached(userRequest, 'users', () => request<{ users: LinearAssignee[] }>('/api/linear/users').then((body) => body.users)),
  updateLinearIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) =>
    post<Snapshot>(`/api/linear/issues/${encodeURIComponent(identifier)}`, patch),
  searchLinearIssues: (query: string) =>
    request<{ issues: { identifier: string; title: string | null; url: string | null }[] }>(
      `/api/linear/issues?q=${encodeURIComponent(query)}`,
    ).then((body) => body.issues),
  linkLinearIssue: (key: string, identifier: string) => post<Snapshot>('/api/linear/links', { key, identifier }),
  pullFeedback: (key: string) => request<FeedbackPayload>(`/api/feedback?key=${encodeURIComponent(key)}`),
  replyToThread: (key: string, threadId: string, body: string) => post<FeedbackPayload>('/api/feedback/reply', { key, threadId, body }),
  replyToNote: (key: string, noteId: string, body: string) => post<FeedbackPayload>('/api/feedback/note', { key, noteId, body }),
  setThreadResolved: (key: string, threadId: string, resolved: boolean) =>
    post<FeedbackPayload>('/api/feedback/resolve', { key, threadId, resolved }),
}

const statusRequests = new Map<string, Promise<LinearStatus[]>>()
const userRequest = new Map<string, Promise<LinearAssignee[]>>()

function cached<T>(slot: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = slot.get(key)
  if (existing) return existing
  const pending = load().catch((error) => {
    slot.delete(key)
    throw error
  })
  slot.set(key, pending)
  return pending
}
