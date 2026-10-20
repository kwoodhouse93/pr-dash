import type { Snapshot } from '../shared/types.ts'

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
  refresh: () => post<Snapshot>('/api/refresh', {}),
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
  rerun: (keys: string[], mode: 'failed' | 'all') => post<{ reran: number; errors: string[] }>('/api/rerun', { keys, mode }),
}
