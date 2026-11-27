// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueSnapshot } from '../src/shared/queue.ts'
import { SYNC_CANCELLED, type SyncStatus } from '../src/shared/sync.ts'
import type { Snapshot } from '../src/shared/types.ts'
import { pullRequest } from './support/pull.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  feedback: vi.fn(),
  mergeQueue: vi.fn(),
  status: vi.fn(),
  activity: vi.fn(),
  agentChecks: vi.fn(),
}))

vi.mock('../src/web/api.ts', async (original) => ({
  ...(await original<typeof import('../src/web/api.ts')>()),
  api: server,
}))

const { App } = await import('../src/web/App.tsx')

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    viewer: 'ada',
    syncedAt: null,
    mineSyncedAt: null,
    reviewSyncedAt: null,
    repos: ['initech/frontend'],
    pullRequests: [pullRequest(1)],
    reviewPullRequests: [],
    departed: [],
    initiatives: [],
    linearConfigured: false,
    warning: null,
    ...over,
  }
}

const idle: SyncStatus = {
  running: false,
  message: 'Idle',
  completed: 0,
  total: 0,
  activity: null,
  queue: [],
  history: [],
  graphql: { paused: false, limit: null, remaining: null, resetAt: null, message: null, windows: [] },
  rules: [],
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  })
}

describe('the dashboard', () => {
  let root: Root | null = null

  beforeEach(() => {
    localStorage.clear()
    for (const call of Object.values(server)) call.mockReset()
    server.mergeQueue.mockResolvedValue({ entries: [], history: [] } satisfies QueueSnapshot)
    server.status.mockResolvedValue(idle)
    server.activity.mockRejectedValue(new Error('not asked for'))
    // The providers never answer here, so the Settings button has nothing to say.
    server.agentChecks.mockReturnValue(new Promise(() => {}))
    server.feedback.mockImplementation(async () => ({ snapshot: snapshot({ mineSyncedAt: new Date().toISOString() }), pending: 0, paused: false }))
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function open() {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => root!.render(<App />))
    await settle()
    return host
  }

  it('shows the saved list, then asks for a refresh and shows what comes back', async () => {
    server.snapshot.mockResolvedValue(snapshot())
    server.refresh.mockResolvedValue(snapshot({ mineSyncedAt: new Date().toISOString(), pullRequests: [pullRequest(1), pullRequest(2)] }))
    server.feedback.mockResolvedValue({
      snapshot: snapshot({ mineSyncedAt: new Date().toISOString(), pullRequests: [pullRequest(1), pullRequest(2)] }),
      pending: 0,
      paused: false,
    })
    const host = await open()
    expect(server.refresh).toHaveBeenCalledWith('mine', false, false)
    expect([...host.querySelectorAll('tr[data-row]')].map((row) => row.getAttribute('data-row'))).toEqual(['initech/frontend#2', 'initech/frontend#1'])
  })

  it('does not ask GitHub for anything until a repository is chosen', async () => {
    server.snapshot.mockResolvedValue(snapshot({ repos: [], pullRequests: [] }))
    const host = await open()
    expect(server.refresh).not.toHaveBeenCalled()
    expect(host.textContent).toContain('No repositories selected')
  })

  it('says nothing when a refresh was cancelled, and says so when one failed', async () => {
    server.snapshot.mockResolvedValue(snapshot())
    server.refresh.mockRejectedValue(Object.assign(new Error('Sync cancelled'), { body: { code: SYNC_CANCELLED } }))
    const host = await open()
    expect(document.body.textContent).not.toContain('Refresh failed')
    expect(host.querySelectorAll('tr[data-row]')).toHaveLength(1)
    act(() => root?.unmount())
    document.body.innerHTML = ''

    server.refresh.mockRejectedValue(new Error('GitHub is down'))
    await open()
    expect(document.body.textContent).toContain('GitHub is down')
  })
})
