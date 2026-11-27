// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { MergeEntry, QueueSnapshot } from '../src/shared/queue.ts'
import { MergeQueuePage } from '../src/web/queue.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function entry(logs: MergeEntry['logs']): MergeEntry {
  return {
    id: 'entry-1',
    position: 1,
    kind: 'pr',
    repo: 'acme/app',
    trunk: 'main',
    title: 'Ship the queue',
    status: 'active',
    error: 'Rebase failed',
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T09:05:00.000Z',
    startedAt: '2026-10-22T09:01:00.000Z',
    finishedAt: '2026-10-22T09:05:00.000Z',
    steps: [
      {
        id: 'step-1',
        position: 1,
        prKey: 'acme/app#7',
        number: 7,
        title: 'Ship the queue',
        url: 'https://github.com/acme/app/pull/7',
        headRef: 'queue',
        headOid: 'abc',
        baseRef: 'main',
        baseOid: null,
        role: 'merge',
        status: 'failed',
        detail: null,
      },
    ],
    logs,
  }
}

function snapshot(logs: MergeEntry['logs']): QueueSnapshot {
  return { entries: [entry(logs)], history: [] }
}

describe('merge queue logs', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function render(queue: QueueSnapshot) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<MergeQueuePage queue={queue} onCancel={async () => {}} onRetry={async () => {}} onMove={async () => {}} />)
    })
  }

  it('keeps logs collapsed until they are folded out', async () => {
    await render(
      snapshot([
        { id: 1, at: '2026-10-22T09:01:02.000Z', level: 'info', message: 'Waiting for checks' },
        { id: 2, at: '2026-10-22T09:04:08.000Z', level: 'error', message: 'Rebase rejected' },
      ]),
    )

    const toggle = document.querySelector<HTMLButtonElement>('.queue-log-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.textContent).toContain('Logs')
    expect(toggle?.textContent).toContain('2 lines')
    expect(document.querySelector('.queue-log')).toBeNull()
    expect(document.body.textContent).toContain('Rebase failed')
    expect(document.body.textContent).not.toContain('Waiting for checks')

    await act(async () => {
      toggle!.click()
    })

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    const log = document.querySelector('.queue-log')
    expect(log?.textContent).toContain('09:01:02  Waiting for checks')
    expect(log?.textContent).toContain('09:04:08  Rebase rejected')

    await act(async () => {
      toggle!.click()
    })

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.queue-log')).toBeNull()
  })

  it('shows the newest log line on the entry in flight', async () => {
    await render(
      snapshot([
        { id: 1, at: '2026-10-22T09:01:02.000Z', level: 'info', message: 'Waiting for checks' },
        { id: 2, at: '2026-10-22T09:04:08.000Z', level: 'info', message: 'Squash merging #7.' },
      ]),
    )
    expect(document.querySelector('.queue-log-last')?.textContent).toBe('09:04:08  Squash merging #7.')
  })

  it('omits the log toggle when an entry has no logs', async () => {
    await render(snapshot([]))
    expect(document.querySelector('.queue-log-toggle')).toBeNull()
    expect(document.querySelector('.queue-log')).toBeNull()
  })

  it('keeps finished entries to one line until they are opened', async () => {
    const done = { ...entry([]), status: 'done' as const, error: null }
    await render({ entries: [], history: [done] })

    expect(document.body.textContent).toContain('took 4m')
    expect(document.querySelector('.queue-rail')).toBeNull()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.queue-row-main')!.click()
    })
    expect(document.querySelector('.queue-rail')?.textContent).toContain('#7 Ship the queue')
  })

  it('holds a failed entry aside, and retries or removes it', async () => {
    const failed = { ...entry([]), status: 'failed' as const, error: '#7 has a merge conflict.' }
    const removed: string[] = []
    const retried: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MergeQueuePage
          queue={{ entries: [failed], history: [] }}
          onCancel={async (id) => {
            removed.push(id)
          }}
          onRetry={async (id) => {
            retried.push(id)
          }}
          onMove={async () => {}}
        />,
      )
    })

    expect(document.querySelector('.queue-repo-head')?.textContent).toBe('acme/app1 held')
    expect(document.body.textContent).toContain('#7 has a merge conflict.')
    expect(document.querySelector('.queue-clock')).toBeNull()

    const remove = document.querySelector<HTMLButtonElement>('.queue-now .ghost')
    expect(remove?.textContent).toBe('Remove')
    const retry = document.querySelector<HTMLButtonElement>('.queue-now .primary')
    expect(retry?.textContent).toBe('Retry')
    await act(async () => {
      retry!.click()
    })
    expect(retried).toEqual(['entry-1'])
    await act(async () => {
      remove!.click()
    })
    expect(removed).toEqual(['entry-1'])
  })

  it('gives each repository its own section, with its own numbering and reorder limits', async () => {
    const queued = (id: string, repo: string, title: string): MergeEntry => ({ ...entry([]), id, repo, title, status: 'queued', error: null })
    await render({
      entries: [
        { ...entry([]), id: 'web-now', repo: 'acme/web', error: null },
        queued('web-1', 'acme/web', 'Web first'),
        queued('app-1', 'acme/app', 'App first'),
        queued('web-2', 'acme/web', 'Web second'),
      ],
      history: [],
    })

    const sections = [...document.querySelectorAll('.queue-repo-section')]
    expect(sections.map((section) => section.querySelector('.queue-repo-head')?.textContent)).toEqual(['acme/app1 waiting', 'acme/webmerging · 2 waiting'])
    const web = sections[1]!
    expect(web.querySelectorAll('.queue-now')).toHaveLength(1)
    expect([...web.querySelectorAll('.queue-row')].map((row) => row.textContent)).toEqual(['1Web first#7', '2Web second#7'])
    const app = sections[0]!
    expect(app.querySelector<HTMLButtonElement>('[aria-label="Move up"]')?.disabled).toBe(true)
    expect(app.querySelector<HTMLButtonElement>('[aria-label="Move down"]')?.disabled).toBe(true)
  })
})
