import type { QueueSnapshot } from '../shared/queue.ts'
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

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  status: () => request<{ running: boolean; message: string }>('/api/status'),
  refresh: (focus: 'mine' | 'review' = 'mine') => post<Snapshot>('/api/refresh', { focus }),
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
  resolveConflictWithCursor: (key: string) => post<Snapshot>(`/api/conflicts/${encodeURIComponent(key)}/cursor`, {}),
  merge: (key: string) => post<Snapshot>('/api/merge', { key }),
  mergeQueue: () => request<QueueSnapshot>('/api/merge-queue'),
  enqueue: (key: string, scope: 'pr' | 'downstack') => post<QueueSnapshot>('/api/merge-queue', { key, scope }),
  cancelMerge: (id: string) => post<QueueSnapshot>(`/api/merge-queue/${id}/cancel`, {}),
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
