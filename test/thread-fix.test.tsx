// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../src/shared/agents.ts'
import type { FeedbackPayload } from '../src/shared/feedback.ts'
import { AgentProvider } from '../src/web/agent-launch.tsx'
import { api } from '../src/web/api.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { Feedback, type FeedbackTarget } from '../src/web/feedback.tsx'

vi.mock('../src/web/api.ts', () => ({
  api: { pullFeedback: vi.fn() },
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const target: FeedbackTarget = {
  key: 'acme/app#7',
  number: 7,
  title: 'Ship the queue',
  url: 'https://github.com/acme/app/pull/7',
  threads: 1,
  unresolved: 0,
  awaiting: 0,
  unread: 0,
  resolvedUnread: 0,
  comments: 0,
  reviewComments: 0,
  truncated: false,
  detailsPending: false,
}

function payload(): FeedbackPayload {
  return {
    counts: {
      threadCount: 1,
      unresolvedCount: 1,
      awaitingYouCount: 0,
      unreadCount: 0,
      resolvedUnreadCount: 0,
      awaitingThreadUrl: null,
      unresolvedThreadUrl: null,
      unreadThreadUrl: null,
      resolvedUnreadThreadUrl: null,
      commentAwaitingCount: 0,
      reviewCommentAwaitingCount: 0,
      threadsTruncated: false,
    },
    local: {},
    detail: {
      pullId: 'pr-7',
      title: 'Ship the queue',
      url: 'https://github.com/acme/app/pull/7',
      number: 7,
      threadsTruncated: false,
      notes: [],
      threads: [
        {
          id: 'thread-1',
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
          path: 'src/web/queue.tsx',
          line: 18,
          startLine: 12,
          url: 'https://github.com/acme/app/pull/7#discussion_r1',
          diffHunk: '@@ -1 +1 @@\n-old\n+new\n',
          commentsTruncated: false,
          comments: [
            {
              id: 'comment-1',
              author: { __typename: 'User', login: 'ada', avatarUrl: null },
              createdAt: '2026-10-20T12:00:00Z',
              body: 'Please rename this.',
              url: 'https://github.com/acme/app/pull/7#discussion_r1',
              diffHunk: null,
            },
          ],
        },
      ],
    },
  }
}

describe('fix a review thread with Cursor', () => {
  let root: Root | null = null
  let opened: string[] = []

  beforeEach(() => {
    opened = []
    vi.mocked(api.pullFeedback).mockReset()
    vi.mocked(api.pullFeedback).mockResolvedValue(payload())
    const tab = {
      document: { open() {}, write() {}, close() {} },
      location: { replace: (url: string) => opened.push(url) },
      opener: null,
      close() {},
    }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function render(onStart: (key: string, request: AgentRequest) => Promise<{ url: string }>, targets: FeedbackTarget[] = [target]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <AgentProvider start={onStart}>
          <MenuProvider>
            <Feedback mode="mine" targets={targets} />
          </MenuProvider>
        </AgentProvider>,
      )
    })
  }

  async function click(element: Element | null | undefined) {
    expect(element).toBeTruthy()
    await act(async () => {
      ;(element as HTMLElement).click()
    })
  }

  async function openThread() {
    await click(document.querySelector('.feedback-hit'))
    expect(document.querySelector('.thread-card')?.textContent).toContain('Please rename this.')
  }

  it('highlights unresolved threads the same way as ones awaiting you', async () => {
    await render(async () => ({ url: 'https://cursor.com/agents/unused' }), [{ ...target, threads: 2, unresolved: 2, awaiting: 1 }])
    expect([...document.querySelectorAll('.feedback-hit.await')].map((node) => node.getAttribute('aria-label'))).toEqual(['1 awaiting', '2 unresolved'])
    expect(document.querySelector('.feedback')?.getAttribute('title')).toContain('Unresolved threads block merge.')
  })

  it('starts a fix from the thread with no extra prompt', async () => {
    const started: { key: string; request: AgentRequest }[] = []
    await render(async (key, request) => {
      started.push({ key, request })
      return { url: 'https://cursor.com/agents/bc-9' }
    })
    await openThread()
    await click(document.querySelector('button[aria-label="Fix src/web/queue.tsx:12-18 with Cursor"]'))
    expect(started).toEqual([
      {
        key: 'acme/app#7',
        request: {
          kind: 'thread',
          prompt: null,
          thread: {
            id: 'thread-1',
            path: 'src/web/queue.tsx',
            line: 18,
            startLine: 12,
            url: 'https://github.com/acme/app/pull/7#discussion_r1',
            outdated: false,
            diffHunk: '@@ -1 +1 @@\n-old\n+new\n',
            truncated: false,
            comments: [{ author: 'ada', body: 'Please rename this.' }],
          },
        },
      },
    ])
    expect(opened).toEqual(['https://cursor.com/agents/bc-9'])
  })

  it('adds a prompt from the caret without replacing the thread', async () => {
    const started: AgentRequest[] = []
    await render(async (_key, request) => {
      started.push(request)
      return { url: 'https://cursor.com/agents/bc-8' }
    })
    await openThread()
    await click(document.querySelector('button[aria-label="Fix src/web/queue.tsx:12-18 with a prompt"]'))
    const form = document.querySelector<HTMLFormElement>('.thread-fix')
    const textarea = form?.querySelector('textarea')
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
    expect(submit?.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep the public name.')
      textarea?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit?.disabled).toBe(false)
    await click(submit)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ kind: 'thread', prompt: 'Keep the public name.' })
    if (started[0]?.kind === 'thread') expect(started[0].thread.comments[0]?.body).toBe('Please rename this.')
    expect(opened).toEqual(['https://cursor.com/agents/bc-8'])
    expect(document.querySelector('.thread-fix')).toBeNull()
  })
})
