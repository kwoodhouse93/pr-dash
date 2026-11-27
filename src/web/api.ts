import type { Activity } from '../shared/activity.ts'
import type { AgentRequest, AgentSettings } from '../shared/agents.ts'
import type { FeedbackPayload } from '../shared/feedback.ts'
import type { QueueSnapshot } from '../shared/queue.ts'
import type { RepoCatalog } from '../shared/repos.ts'
import { SYNC_CANCELLED, type FeedbackLoad, type SyncStatus } from '../shared/sync.ts'
import type { AgentProviderId, LinearAssignee, LinearStatus, RepoMark, Snapshot, ListName } from '../shared/types.ts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const text = await response.text()
  let body: { error?: string; code?: string } = {}
  if (text) {
    try {
      body = JSON.parse(text) as { error?: string; code?: string }
    } catch {
      if (!response.ok) throw new Error(text.slice(0, 240))
      throw new Error('The server returned an unreadable response.')
    }
  }
  // The body rides along for callers that act on more than the message.
  if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), { body })
  return body as T
}

/** A refresh that was cancelled to make way for another. Nothing went wrong, so nothing is said. */
export function syncCancelled(caught: unknown): boolean {
  return (caught as { body?: { code?: unknown } } | null)?.body?.code === SYNC_CANCELLED
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export type { FeedbackLoad, SyncHistoryEntry, SyncJob, SyncKind, SyncStatus } from '../shared/sync.ts'

export const api = {
  snapshot: (focus?: ListName) => request<Snapshot>(focus ? `/api/snapshot?focus=${focus}` : '/api/snapshot'),
  status: () => request<SyncStatus>('/api/status'),
  repos: () => request<RepoCatalog>('/api/repos'),
  addRepo: (repo: string) => post<Snapshot>('/api/repos', { repo }),
  removeRepo: (repo: string) => post<Snapshot>('/api/repos/remove', { repo }),
  setRepoMark: (repo: string, mark: RepoMark) => post<Snapshot>('/api/repos/mark', { repo, ...mark }),
  refresh: (focus: ListName = 'mine', full = false, interactive = false) => post<Snapshot>('/api/refresh', { focus, full, interactive }),
  enqueueSync: (kind: 'full' | 'rules', focus: ListName) => post<SyncStatus>('/api/sync', { kind, focus }),
  cancelSync: (id: string) => post<SyncStatus>(`/api/sync/${encodeURIComponent(id)}/cancel`, {}),
  feedback: (focus: ListName) => post<FeedbackLoad>('/api/feedback', { focus }),
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
  assign: (initiativeId: string, prKeys: string[], action: 'add' | 'remove') => post<Snapshot>('/api/assignments', { initiativeId, prKeys, action }),
  rerun: (keys: string[], mode: 'failed' | 'all') =>
    post<{ reran: number; errors: string[]; runs: { repo: string; runId: number }[] }>('/api/rerun', { keys, mode }),
  startAgent: (key: string, request: AgentRequest, provider?: AgentProviderId) =>
    post<{ snapshot: Snapshot; agentId: string; provider: AgentProviderId; url: string | null }>('/api/pulls/agents', { key, ...request, provider }),
  agentSettings: () => request<AgentSettings>('/api/agents'),
  pairT3: () => post<{ pairUrl: string; origin: string }>('/api/agents/t3/pair', {}),
  setDefaultAgent: (defaultProvider: AgentProviderId) => post<{ settings: AgentSettings; snapshot: Snapshot }>('/api/agents', { defaultProvider }),
  setRepoAgent: (repo: string, agent: { provider: AgentProviderId | null; checkout: string | null }) =>
    post<{ settings: AgentSettings; snapshot: Snapshot }>('/api/agents/repo', { repo, ...agent }),
  rebase: (key: string) => post<Snapshot>('/api/rebase', { key }),
  activity: () => request<Activity>('/api/activity'),
  mergeQueue: () => request<QueueSnapshot>('/api/merge-queue'),
  enqueue: (key: string, scope: 'pr' | 'downstack' | 'unapproved') => post<QueueSnapshot>('/api/merge-queue', { key, scope }),
  cancelMerge: (id: string) => post<QueueSnapshot>(`/api/merge-queue/${id}/cancel`, {}),
  retryMerge: (id: string) => post<QueueSnapshot>(`/api/merge-queue/${id}/retry`, {}),
  moveMerge: (id: string, direction: 'up' | 'down') => post<QueueSnapshot>(`/api/merge-queue/${id}/move`, { direction }),
  linearStatuses: (query: { teamId?: string | null; issue: string }) => {
    const key = query.teamId || query.issue
    return cached(statusRequests, key, () => {
      const params = query.teamId ? `teamId=${encodeURIComponent(query.teamId)}` : `issue=${encodeURIComponent(query.issue)}`
      return request<{ statuses: LinearStatus[] }>(`/api/linear/statuses?${params}`).then((body) => body.statuses)
    })
  },
  linearUsers: () => cached(userRequest, 'users', () => request<{ users: LinearAssignee[] }>('/api/linear/users').then((body) => body.users)),
  updateLinearIssue: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) =>
    post<Snapshot>(`/api/linear/issues/${encodeURIComponent(identifier)}`, patch),
  searchLinearIssues: (query: string) =>
    request<{ issues: { identifier: string; title: string | null; url: string | null }[] }>(`/api/linear/issues?q=${encodeURIComponent(query)}`).then(
      (body) => body.issues,
    ),
  linkLinearIssue: (key: string, identifier: string) => post<Snapshot>('/api/linear/links', { key, identifier }),
  setLocallyResolved: (key: string, itemId: string, resolved: boolean) => post<FeedbackPayload>('/api/feedback/local', { key, itemId, resolved }),
  pullFeedback: (key: string) => request<FeedbackPayload>(`/api/feedback?key=${encodeURIComponent(key)}`),
  replyToThread: (key: string, threadId: string, body: string) => post<FeedbackPayload>('/api/feedback/reply', { key, threadId, body }),
  replyToNote: (key: string, noteId: string, body: string) => post<FeedbackPayload>('/api/feedback/note', { key, noteId, body }),
  setThreadResolved: (key: string, threadId: string, resolved: boolean) => post<FeedbackPayload>('/api/feedback/resolve', { key, threadId, resolved }),
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
