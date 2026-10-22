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
    status: 'done',
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
        role: 'merge',
        status: 'failed',
        detail: null,
      },
    ],
    logs,
  }
}

function snapshot(logs: MergeEntry['logs']): QueueSnapshot {
  return { paused: false, pauseReason: null, entries: [entry(logs)], history: [], watches: [] }
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
      root?.render(
        <MergeQueuePage queue={queue} onCancel={async () => {}} onMove={async () => {}} />,
      )
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

  it('omits the log toggle when an entry has no logs', async () => {
    await render(snapshot([]))
    expect(document.querySelector('.queue-log-toggle')).toBeNull()
    expect(document.querySelector('.queue-log')).toBeNull()
  })
})
