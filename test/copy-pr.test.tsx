// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarize } from '../src/shared/stacks.ts'
import type { PullRequest } from '../src/shared/types.ts'
import type { Outline, StackBlock } from '../src/shared/view.ts'
import { reviewChase } from '../src/web/chase.ts'
import { copyPrIdsLabel, prCopyList } from '../src/web/format.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { PrTable } from '../src/web/table.tsx'
import { toastError, toastSuccess } from '../src/web/toasts.tsx'
import { pullRequest } from './support/pull.ts'

vi.mock('../src/web/toasts.tsx', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function pull(number: number, repoName = 'frontend'): PullRequest {
  const repo = repoName === 'frontend' ? 'initech/frontend' : `initech/${repoName}`
  return {
    ...pullRequest(number),
    id: `pr-${number}`,
    key: `${repo}#${number}`,
    repo,
    repoName,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headRef: `branch-${number}`,
  }
}

function outlineFor(prs: PullRequest[]): Outline {
  const block: StackBlock = {
    id: 'stack',
    stackKeys: prs.map((pr) => pr.key),
    parents: Object.fromEntries(prs.map((pr, index) => [pr.key, prs[index + 1]?.key ?? null])),
    collapsible: prs.length > 1,
    summary: summarize(prs, false),
    rows: prs.map((pr) => ({ type: 'pr', pr })),
  }
  return {
    projects: [],
    initiatives: [],
    looseIssues: [],
    unassigned: {
      id: 'unassigned',
      title: null,
      href: null,
      meta: null,
      count: prs.length,
      issueId: null,
      stacks: prs.length > 1 ? [block] : [],
      singles: prs.length > 1 ? [] : [block],
    },
  }
}

describe('copy pull request ids', () => {
  let root: Root | null = null
  const writeText = vi.fn(async (_text: string) => {})
  const toggled: string[] = []

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    toggled.length = 0
    writeText.mockReset()
    writeText.mockImplementation(async () => {})
    vi.mocked(toastSuccess).mockClear()
    vi.mocked(toastError).mockClear()
  })

  async function render(prs: PullRequest[], expanded = false) {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    document.body.innerHTML = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MenuProvider>
          <PrTable
            mode="mine"
            outline={outlineFor(prs)}
            sort={{ key: 'updated', dir: 'desc' }}
            initiatives={[]}
            prByKey={new Map(prs.map((pr) => [pr.key, pr]))}
            showRepo={false}
            expanded={expanded ? new Set(['unassigned:stack']) : new Set()}
            collapsed={new Set()}
            onSort={() => {}}
            onToggle={(id) => toggled.push(id)}
            onToggleSection={() => {}}
            onAssign={async () => {}}
            onCreateAssigned={async () => {}}
            onMerge={async () => {}}
            onRetry={async () => {}}
            onStackMerge={async () => {}}
            onMarkReady={async () => {}}
            queueByKey={new Map()}
            holds={new Map()}
            onRerun={async () => ''}
            onStartAgent={async () => ({ url: 'https://example.test' })}
            onRebase={async () => {}}
            flat={new Set()}
            onToggleFlat={() => {}}
            onRefreshPr={async () => {}}
            linearConfigured={false}
            onUpdateIssue={async () => {}}
            onLinkIssue={async () => {}}
            viewer={null}
            onFeedback={() => {}}
          />
        </MenuProvider>,
      )
    })
  }

  async function click(element: Element | null | undefined) {
    expect(element).toBeTruthy()
    await act(async () => {
      ;(element as HTMLElement).click()
    })
  }

  function rowFor(number: number): HTMLTableRowElement {
    const cell = [...document.querySelectorAll('td.num')].find((item) => item.textContent?.includes(String(number)))
    const row = cell?.closest('tr')
    expect(row).toBeTruthy()
    return row as HTMLTableRowElement
  }

  function menuItem(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('button.menu-item')].find((item) => item.getAttribute('aria-label') === text)
  }

  it('formats a trunk-first list', () => {
    const prs = [pull(1236), pull(1235), pull(1234)]
    expect(prCopyList(prs.slice().reverse())).toBe('frontend#1234, frontend#1235, frontend#1236')
    expect(copyPrIdsLabel(1)).toBe('Copy 1 PR ID')
    expect(copyPrIdsLabel(3)).toBe('Copy 3 PR IDs')
  })

  it('copies the number in the column and leaves the title as a link', async () => {
    const pr = pull(4685, 'backend')
    await render([pr])
    const number = document.querySelector('td.num button')
    expect(number?.getAttribute('aria-label')).toBe('Copy backend#4685')
    expect(number?.textContent).toBe('4685')
    expect(document.querySelector('td.num a')).toBeNull()
    expect(document.querySelector('td.num .copy-icon')).not.toBeNull()
    expect(document.querySelector('td.title-block a')?.getAttribute('href')).toBe(pr.url)

    await click(number)
    expect(writeText).toHaveBeenCalledWith('backend#4685')
    expect(toastSuccess).toHaveBeenCalledWith('Copied backend#4685')
    expect(toggled).toEqual([])
  })

  it('copies the current pull request and its downstack from the row menu', async () => {
    const top = pull(1236)
    const middle = pull(1235)
    const bottom = pull(1234)
    top.baseRef = 'branch-1235'
    middle.baseRef = 'branch-1234'
    middle.headRef = 'branch-1235'
    bottom.headRef = 'branch-1234'
    const prs = [top, middle, bottom]

    await render(prs)
    expect(document.querySelector('td.num button')?.textContent).toBe('1236')
    await click(document.querySelector('button.row-menu'))
    expect(menuItem('Copy 3 PR IDs')).toBeTruthy()
    await click(menuItem('Copy 3 PR IDs'))
    expect(writeText).toHaveBeenCalledWith('frontend#1234, frontend#1235, frontend#1236')
    expect(toastSuccess).toHaveBeenCalledWith('Copied 3 PR IDs')
    expect(document.querySelector('.popover')).toBeNull()

    await render(prs, true)
    await click(rowFor(1235).querySelector('button.row-menu'))
    expect(menuItem('Copy 2 PR IDs')).toBeTruthy()
    await click(menuItem('Copy 2 PR IDs'))
    expect(writeText).toHaveBeenLastCalledWith('frontend#1234, frontend#1235')

    await click(rowFor(1234).querySelector('button.row-menu'))
    expect(menuItem('Copy 1 PR ID')?.querySelector('.menu-label')?.textContent).toBe('PR ID')
    await click(menuItem('Copy 1 PR ID'))
    expect(writeText).toHaveBeenLastCalledWith('frontend#1234')
    expect(toastSuccess).toHaveBeenCalledWith('Copied frontend#1234')
  })

  function waitingPull(number: number, readyAt: string): PullRequest {
    return { ...pull(number), reviewDecision: 'REVIEW_REQUIRED', humanApproval: false, readyAt, additions: 180, deletions: 12 }
  }

  it('writes a review chase for a stack, bottom first, without drafts', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const bottom = waitingPull(412, '2026-10-08T11:00:00Z')
    const middle = pull(413)
    const top = waitingPull(414, '2026-10-10T07:00:00Z')
    const draft = { ...waitingPull(415, '2026-10-01T00:00:00Z'), isDraft: true }
    const message = reviewChase([bottom, middle, top, draft], now)
    expect(message?.text).toBe(
      [
        '👀 Still looking for review - 2 need review, oldest has been waiting 2 days',
        '',
        '1) #412 Change 412 · +180 −12 · GitHub: https://github.com/initech/frontend/pull/412 · Graphite: https://app.graphite.com/github/pr/initech/frontend/412',
        '2) #413 Change 413 · +1 −0 · ✅ approved · GitHub: https://github.com/initech/frontend/pull/413 · Graphite: https://app.graphite.com/github/pr/initech/frontend/413',
        '3) #414 Change 414 · +180 −12 · GitHub: https://github.com/initech/frontend/pull/414 · Graphite: https://app.graphite.com/github/pr/initech/frontend/414',
      ].join('\n'),
    )
    expect(message?.html).toContain('<ol><li><code>#412</code> Change 412 · +180 −12 · <a href="https://github.com/initech/frontend/pull/412">GitHub</a>')
    expect(reviewChase([bottom, middle], now)?.text.split('\n')[0]).toBe('👀 Still looking for review - 1 needs review, waiting 2 days')
  })

  // Slack's own test for Markdown in pasted plain text, as of its client in 2026. When it matches, Slack drops the HTML.
  function slackSeesMarkdown(text: string): boolean {
    const bare = text.replace(/https?:\/\/[^\s)]+/g, '')
    return (
      /^`{3,}\S+\s*$/m.test(text) ||
      /^#{2,6}\s+?\S/m.test(text) ||
      /^#\s+\S/m.test(text) ||
      /^---\s*$/m.test(text) ||
      /(?<!\w)\*\*(?!\s)(.{2,}?)(?<!\s)\*\*/.test(text) ||
      /(?<=\s)__(?!\s)(.{2,}?)(?<!\s)__(?=\s|$|[.,;:!?)])/.test(bare) ||
      /(?<!\w|\*)\*(?!\*|\s)(.{2,}?)(?<!\s|\*)\*(?!\*)/.test(text) ||
      /(?<=\s)_(?!_|\s)(.{2,}?)(?<!\s|_)_(?=\s|$|[.,;:!?)])/.test(bare) ||
      /(?<=\s|^)~~(?!\s)(.{2,}?)(?<!\s)~~/.test(text) ||
      /`[^\s`]/.test(text) ||
      /(?<![\w'"\])])\[.+?\]\(.+?\)/.test(text) ||
      /^[-*] [^\s]/m.test(text) ||
      /^\d+?\. [^\s]/m.test(text) ||
      /^> [^\s]/m.test(text)
    )
  }

  it('keeps the plain text free of Markdown, so Slack pastes the rich version', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const first = { ...waitingPull(412, '2026-10-08T11:00:00Z'), title: 'fix(http): handle `retry-after` and *all* ~~old~~ callers' }
    const second = waitingPull(413, '2026-10-09T11:00:00Z')
    expect(slackSeesMarkdown('1. #412 Change')).toBe(true)
    expect(slackSeesMarkdown(reviewChase([first, second], now)!.text)).toBe(false)
    expect(slackSeesMarkdown(reviewChase([first], now)!.text)).toBe(false)
    expect(reviewChase([first], now)!.html).toContain('handle `retry-after` and *all* ~~old~~ callers')
  })

  it('writes a review chase for one pull request and nothing once approved', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const pr = { ...waitingPull(412, '2026-10-10T07:00:00Z'), title: 'Fix <b> & co' }
    const message = reviewChase([pr], now)
    expect(message?.text).toBe(
      '👀 Still looking for review - #412 Fix <b> & co · +180 −12 · waiting 5 hours · GitHub: https://github.com/initech/frontend/pull/412 · Graphite: https://app.graphite.com/github/pr/initech/frontend/412',
    )
    expect(message?.html).toContain('Fix &lt;b&gt; &amp; co')
    expect(reviewChase([pull(413)], now)).toBeNull()
    expect(reviewChase([{ ...pr, isDraft: true }], now)).toBeNull()
  })

  it('offers a review chase for the stack and for one pull request', async () => {
    const top = waitingPull(1236, '2026-10-02T00:00:00Z')
    const bottom = pull(1234)
    top.baseRef = 'branch-1234'
    bottom.headRef = 'branch-1234'

    await render([top, bottom])
    await click(document.querySelector('button.row-menu'))
    expect(menuItem('Copy review chase for #1236')).toBeUndefined()
    await click(menuItem('Copy review chase for stack'))
    const stackText = writeText.mock.calls.at(-1)?.[0] ?? ''
    expect(
      stackText
        .split('\n')
        .slice(2)
        .map((row) => row.slice(0, 8)),
    ).toEqual(['1) #1234', '2) #1236'])
    expect(toastSuccess).toHaveBeenCalledWith('Copied review chase')
    expect(document.querySelector('.popover')).toBeNull()

    await render([top, bottom], true)
    await click(rowFor(1234).querySelector('button.row-menu'))
    expect(menuItem('Copy review chase for #1234')?.disabled).toBe(true)
    expect(menuItem('Copy review chase for stack')?.disabled).toBe(false)
    await click(rowFor(1236).querySelector('button.row-menu'))
    await click(menuItem('Copy review chase for #1236'))
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('👀 Still looking for review - #1236 Change 1236')
  })

  it('reports a clipboard failure', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await render([pull(4685, 'backend')])
    await click(document.querySelector('td.num button'))
    expect(toastError).toHaveBeenCalledWith('Could not copy to the clipboard')
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
