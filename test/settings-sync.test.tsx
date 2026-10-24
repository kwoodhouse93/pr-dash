// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../src/web/api.ts'
import { SettingsPage } from '../src/web/settings.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    running: false,
    message: 'Idle',
    completed: 0,
    total: 0,
    activity: null,
    queue: [],
    history: [],
    graphql: {
      paused: false,
      limit: null,
      remaining: null,
      resetAt: null,
      message: null,
      windows: [],
    },
    rules: [],
    ...patch,
  }
}

describe('settings sync queue', () => {
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ viewer: null, repos: [], truncated: false, warning: null })),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  async function render(sync: SyncStatus | null, repos = ['acme/app']) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const queued: string[] = []
    const cancelled: string[] = []
    await act(async () => {
      root?.render(
        <SettingsPage
          status={sync}
          repos={repos}
          mineSyncedAt={null}
          reviewSyncedAt={null}
          onEnqueue={(kind) => queued.push(kind)}
          onCancelSync={(id) => cancelled.push(id)}
          onAddRepo={async () => undefined}
          onRemoveRepo={async () => undefined}
        />,
      )
    })
    return { queued, cancelled }
  }

  function button(name: string) {
    return [...document.querySelectorAll('button')].find((item) => item.textContent === name) as HTMLButtonElement | undefined
  }

  it('queues a full sync while another sync is running and disables a kind that is already waiting', async () => {
    const view = await render(
      status({
        running: true,
        message: 'Fetching your pull requests',
        activity: { id: 'sync-1', kind: 'list' },
        queue: [{ id: 'sync-2', kind: 'full' }],
      }),
    )

    expect(button('Full sync queued')?.disabled).toBe(true)
    expect(button('Queue ruleset sync')?.disabled).toBe(false)
    button('Queue ruleset sync')?.click()
    expect(view.queued).toEqual(['rules'])
    expect(document.body.textContent).toContain('List refresh')
    expect(document.body.textContent).toContain('Fetching your pull requests')
    expect(document.body.textContent).toContain('Up next · Full sync')
  })

  it('shows recent full and ruleset syncs and cancels the running one', async () => {
    const view = await render(
      status({
        running: true,
        message: 'Reading rulesets',
        activity: { id: 'sync-9', kind: 'rules' },
        history: [
          {
            id: 'sync-8',
            kind: 'full',
            outcome: 'failed',
            message: 'GitHub 502',
            startedAt: '2026-10-22T12:00:00.000Z',
            finishedAt: '2026-10-22T12:01:00.000Z',
          },
        ],
      }),
    )

    expect(document.body.textContent).toContain('Failed · GitHub 502')
    document.querySelector<HTMLButtonElement>('button[aria-label="Cancel Rulesets"]')?.click()
    expect(view.cancelled).toEqual(['sync-9'])
  })

  it('leaves both syncs available when nothing is queued', async () => {
    await render(status(), [])
    expect(button('Full sync')?.disabled).toBe(true)
    expect(button('Sync rulesets')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Nothing running.')
    expect(document.body.textContent).toContain('No full or ruleset syncs yet.')
  })

  it('stores the default pull request host', async () => {
    const hosts: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SettingsPage
          status={status()}
          repos={[]}
          mineSyncedAt={null}
          reviewSyncedAt={null}
          onEnqueue={() => undefined}
          onCancelSync={() => undefined}
          onAddRepo={async () => undefined}
          onRemoveRepo={async () => undefined}
          prLinks="github"
          onPrLinks={(host) => hosts.push(host)}
        />,
      )
    })

    expect(document.querySelector('[aria-label="Default pull request links"] button[aria-pressed="true"]')?.textContent).toBe('GitHub')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Default pull request links"] button:last-child')?.click()
    })
    expect(hosts).toEqual(['graphite'])
  })
})
