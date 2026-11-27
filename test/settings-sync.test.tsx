// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatus } from '../src/web/api.ts'
import { SettingsPage, type SettingsTab } from '../src/web/settings.tsx'

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

  async function render(sync: SyncStatus | null, repos = ['acme/app'], tab: SettingsTab = 'workspace') {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const queued: string[] = []
    const cancelled: string[] = []
    const added: string[] = []
    await act(async () => {
      root?.render(
        <SettingsPage
          tab={tab}
          status={sync}
          repos={repos}
          mineSyncedAt={null}
          reviewSyncedAt={null}
          onEnqueue={(kind) => queued.push(kind)}
          onCancelSync={(id) => cancelled.push(id)}
          onAddRepo={async (repo) => {
            added.push(repo)
          }}
          onRemoveRepo={async () => undefined}
        />,
      )
    })
    return { queued, cancelled, added }
  }

  async function type(value: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add a repository"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function button(name: string) {
    return [...document.querySelectorAll('button')].find((item) => item.textContent === name) as HTMLButtonElement | undefined
  }

  const renderSync = (sync: SyncStatus | null, repos?: string[]) => render(sync, repos, 'sync')

  it('queues a sync while another is running, and takes one that is waiting back out', async () => {
    const view = await renderSync(
      status({
        running: true,
        message: 'Fetching your pull requests',
        activity: { id: 'sync-1', kind: 'list' },
        queue: [{ id: 'sync-2', kind: 'full' }],
      }),
    )

    button('Sync rulesets')?.click()
    expect(view.queued).toEqual(['rules'])
    expect(document.querySelector('.sync-what')?.textContent).toBe('List refresh · Fetching your pull requests')
    // The sync that is waiting shows on its own button, which takes it back out of the queue.
    button('Full sync queued')?.click()
    expect(view.cancelled).toEqual(['sync-2'])
  })

  it('shows recent full and ruleset syncs and cancels the running one', async () => {
    const view = await renderSync(
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
    await renderSync(status(), [])
    expect(button('Full sync')?.disabled).toBe(true)
    expect(button('Sync rulesets')?.disabled).toBe(true)
    expect(document.querySelector('.sync-what')?.textContent).toBe('Idle. Lists refresh about every minute.')
    expect(document.body.textContent).toContain('No full or ruleset syncs yet.')
  })

  it('shows one group at a time, and marks a group only when something in it wants putting right', async () => {
    await render(status({ running: true, activity: { id: 'sync-1', kind: 'list' } }))
    const tabs = () => [...document.querySelectorAll('.settings-rail button')]
    // Without the agents there is no such group.
    expect(tabs().map((tab) => [tab.querySelector('.rail-name')?.textContent, tab.getAttribute('aria-pressed')])).toEqual([
      ['Workspace', 'true'],
      ['Appearance', 'false'],
      ['Sync', 'false'],
    ])
    expect([...document.querySelectorAll('.panel h2')].map((heading) => heading.textContent)).toEqual(['Repositories', 'Pull requests'])
    // A sync that is running is the dashboard at work, so it marks nothing.
    expect(document.querySelector('.rail-dot')).toBeNull()
    act(() => root?.unmount())
    const base = status()
    await renderSync({ ...base, graphql: { ...base.graphql, paused: true, message: 'Paused until 17:14' } })
    expect([...document.querySelectorAll('.panel h2')].map((heading) => heading.textContent)).toEqual(['Sync'])
    expect(tabs()[2]?.querySelector('.rail-dot')?.getAttribute('aria-label')).toBe('List refreshes are paused')
    expect(document.querySelector('.sync-warn')?.textContent).toBe('Paused until 17:14')
  })

  it('lists the repositories that sync with the age of their rules, and asks before removing one', async () => {
    await render(status({ rules: [{ repo: 'acme/app', fetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }] }), ['acme/app', 'acme/web'])

    const rows = [...document.querySelectorAll('[aria-label="Repositories syncing"] li')].map((row) => row.textContent)
    expect(rows[0]).toContain('acme/app')
    expect(rows[0]).toContain('rules read 2h ago')
    expect(rows[1]).toContain('rules not read yet')
    expect(document.body.textContent).toContain('2 syncing')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Remove acme/web"]')?.click()
    })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Remove acme/web?')
  })

  it('finds a repository under any owner and adds it, and offers saved data for review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          viewer: null,
          truncated: false,
          warning: null,
          repos: [
            { name: 'acme/app', selected: true, stored: true, busy: false },
            { name: 'acme/old', selected: false, stored: true, busy: false },
            { name: 'octo/design-system', selected: false, stored: false, busy: false },
          ],
        }),
      ),
    )
    const view = await render(status())

    await type('design')
    const matches = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Repositories to add"] button')]
    expect(matches.map((item) => item.textContent)).toEqual(['octo/design-system'])
    await act(async () => {
      matches[0]?.click()
    })
    expect(view.added).toEqual(['octo/design-system'])

    expect(document.body.textContent).toContain('1 unselected repository still has saved data')
    await act(async () => {
      button('Review')?.click()
    })
    expect(document.querySelector('[aria-label="Unselected repositories with saved data"]')?.textContent).toContain('acme/old')
  })

  it('adds a repository typed as owner/name that GitHub did not list', async () => {
    const view = await render(status())
    await type('other/thing')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form.repo-add')?.requestSubmit()
    })
    expect(view.added).toEqual(['other/thing'])
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
