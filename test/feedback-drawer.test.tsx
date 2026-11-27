// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedbackPayload } from '../src/shared/feedback.ts'
import { api } from '../src/web/api.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { Feedback, FeedbackProvider, type FeedbackTarget } from '../src/web/feedback.tsx'
import { PrLinksProvider } from '../src/web/pr-links.tsx'

vi.mock('../src/web/api.ts', () => ({
  api: { pullFeedback: vi.fn(), setLocallyResolved: vi.fn() },
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
  threads: 2,
  unresolved: 1,
  awaiting: 0,
  unread: 0,
  resolvedUnread: 1,
  comments: 0,
  reviewComments: 0,
  truncated: false,
  detailsPending: false,
}

function thread(id: string, resolved: boolean, body: string) {
  return {
    id,
    isResolved: resolved,
    isOutdated: false,
    resolvedBy: resolved ? 'ada' : null,
    path: resolved ? 'src/web/done.tsx' : 'src/web/queue.tsx',
    line: resolved ? 4 : 18,
    startLine: null,
    url: `https://github.com/acme/app/pull/7#discussion_${id}`,
    diffHunk: null,
    commentsTruncated: false,
    comments: [
      {
        id: `${id}-comment`,
        author: { __typename: 'User', login: 'ada', avatarUrl: null },
        createdAt: '2026-10-20T12:00:00Z',
        body,
        url: `https://github.com/acme/app/pull/7#discussion_${id}`,
        diffHunk: null,
      },
    ],
  }
}

function payload(): FeedbackPayload {
  return {
    counts: {
      threadCount: 2,
      unresolvedCount: 1,
      awaitingYouCount: 0,
      unreadCount: 0,
      resolvedUnreadCount: 1,
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
      threads: [thread('open', false, 'Please rename this.'), thread('done', true, 'Already handled.')],
    },
  }
}

const note = {
  id: 'note-1',
  author: { __typename: 'User', login: 'ada', avatarUrl: null },
  createdAt: '2026-10-20T13:00:00Z',
  body: 'Can you check the copy?',
  url: 'https://github.com/acme/app/pull/7#issuecomment-1',
  kind: 'comment' as const,
}

function withNote(resolved: boolean): FeedbackPayload {
  const base = payload()
  return {
    counts: { ...base.counts, commentAwaitingCount: resolved ? 0 : 1 },
    detail: { ...base.detail, notes: [note] },
    local: resolved ? { 'note-1': '2026-10-21T00:00:00Z' } : {},
  }
}

describe('feedback drawer', () => {
  let root: Root | null = null
  let hits = 0

  beforeEach(() => {
    hits = 0
    vi.mocked(api.pullFeedback).mockReset()
    vi.mocked(api.pullFeedback).mockResolvedValue(payload())
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function render() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <div
          onClick={() => {
            hits += 1
          }}
        >
          <MenuProvider>
            <Feedback mode="review" targets={[target]} />
          </MenuProvider>
        </div>,
      )
    })
  }

  async function openThreads() {
    const button = document.querySelector<HTMLButtonElement>('button[title="Show unresolved threads"]')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
  }

  function filterButton(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('.feedback-filters button')].find((button) => button.textContent?.startsWith(label))
  }

  async function pick(label: string) {
    const button = filterButton(label)
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
  }

  function press(element: Element | null | undefined) {
    expect(element).toBeTruthy()
    const node = element as HTMLElement
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    node.click()
  }

  it('starts resolved threads collapsed and leaves open threads expanded', async () => {
    await render()
    await openThreads()
    const cards = [...document.querySelectorAll('.thread-card')]
    expect(cards).toHaveLength(2)
    expect(cards[0]?.querySelector('.thread-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(cards[0]?.textContent).toContain('Please rename this.')
    expect(cards[1]?.classList.contains('collapsed')).toBe(true)
    expect(cards[1]?.querySelector('.thread-toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(cards[1]?.querySelector('[hidden]')).toBeTruthy()
    expect(cards[1]?.querySelector('.thread-count')?.textContent).toBe('1 comment')

    await act(async () => {
      cards[1]?.querySelector<HTMLButtonElement>('.thread-toggle')?.click()
    })
    expect(cards[1]?.classList.contains('collapsed')).toBe(false)
    expect(cards[1]?.textContent).toContain('Already handled.')
  })

  it('opens on the filter you clicked and switches to any other', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <FeedbackProvider viewer="grace" onCounts={() => {}}>
          <MenuProvider>
            <Feedback mode="review" targets={[target]} />
          </MenuProvider>
        </FeedbackProvider>,
      )
    })
    await openThreads()
    expect(filterButton('Unresolved')?.getAttribute('aria-pressed')).toBe('true')
    expect(filterButton('Unresolved')?.textContent).toBe('Unresolved1')
    expect([...document.querySelectorAll('.thread-card')].map((card) => card.querySelector('.file-link')?.textContent)).toEqual(['src/web/queue.tsx:18'])

    await pick('All')
    expect(document.querySelectorAll('.thread-card')).toHaveLength(2)

    await pick('Comments')
    expect(document.querySelectorAll('.thread-card')).toHaveLength(0)
    expect(document.querySelector('.drawer-body')?.textContent).toBe('Nothing under Comments.')
  })

  it('keeps the drawer open when the review list behind it would otherwise collapse', async () => {
    await render()
    await openThreads()
    hits = 0
    await act(async () => {
      press(document.querySelector('.drawer textarea'))
      press(document.querySelector('.thread-comment'))
      press(document.querySelector('.drawer-body'))
    })
    expect(hits).toBe(0)
    expect(document.querySelector('.drawer')).toBeTruthy()
    expect(document.querySelector('.drawer textarea')).toBeTruthy()

    await act(async () => {
      press(document.querySelector('.drawer-back'))
    })
    expect(hits).toBe(0)
    expect(document.querySelector('.drawer')).toBeNull()
  })

  it('opens a thread on Graphite when that host is the default', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <PrLinksProvider host="graphite">
          <MenuProvider>
            <Feedback mode="review" targets={[target]} />
          </MenuProvider>
        </PrLinksProvider>,
      )
    })
    await openThreads()
    const link = document.querySelector<HTMLAnchorElement>('.file-link')
    expect(link?.href).toBe('https://app.graphite.com/github/pr/acme/app/7/changes#comment-open-comment')
    expect(link?.title).toBe('Open this diff on Graphite')
    expect(document.querySelector<HTMLAnchorElement>('.drawer-pr')?.href).toBe('https://app.graphite.com/github/pr/acme/app/7')
  })

  it('resolves a conversation comment on the dashboard only, and stops counting it', async () => {
    vi.mocked(api.pullFeedback).mockResolvedValue(withNote(false))
    vi.mocked(api.setLocallyResolved).mockReset()
    vi.mocked(api.setLocallyResolved).mockResolvedValue(withNote(true))
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <FeedbackProvider viewer="grace" onCounts={() => {}}>
          <MenuProvider>
            <Feedback mode="mine" targets={[target]} />
          </MenuProvider>
        </FeedbackProvider>,
      )
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="1 unresolved"]')?.click()
    })
    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('.feedback-filters button')].find((item) => item.textContent?.startsWith('Comments'))?.click()
    })
    const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.thread-card button')].filter((item) => item.textContent === text)
    expect(named('Resolve')).toHaveLength(1)
    await act(async () => {
      named('Resolve')[0]?.click()
    })
    expect(api.setLocallyResolved).toHaveBeenCalledWith('acme/app#7', 'note-1', true)
    expect(named('Unresolve')).toHaveLength(1)
    const comments = [...document.querySelectorAll('.feedback-filters button')].find((item) => item.textContent?.startsWith('Comments'))
    expect(comments?.querySelector('.filter-count')?.textContent).toBe('0')
  })
})
