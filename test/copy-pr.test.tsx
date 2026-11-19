// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarize } from '../src/shared/stacks.ts'
import type { Check, PullRequest } from '../src/shared/types.ts'
import type { Outline, StackBlock } from '../src/shared/view.ts'
import { copyPrIdsLabel, prCopyList } from '../src/web/format.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { PrTable } from '../src/web/table.tsx'
import { toastError, toastSuccess } from '../src/web/toasts.tsx'

vi.mock('../src/web/toasts.tsx', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function check(): Check {
  return {
    name: 'Check',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    required: true,
    url: null,
    workflowName: null,
    workflowRunId: null,
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: '2026-10-20T12:05:00Z',
  }
}

function pull(number: number, repoName = 'frontend'): PullRequest {
  const repo = repoName === 'frontend' ? 'initech/frontend' : `initech/${repoName}`
  return {
    id: `pr-${number}`,
    key: `${repo}#${number}`,
    repo,
    repoName,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: 'ada',
    authorAvatarUrl: null,
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    committedAt: '2026-10-02T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    baseRef: 'main',
    headRef: `branch-${number}`,
    defaultBranch: 'main',
    squashMergeAllowed: true,
    requiredApprovals: 1,
    dismissStale: false,
    requiredCheckNames: ['Check'],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeMark: 'met',
    mergeDetail: '',
    anyApproval: true,
    humanApproval: true,
    changesRequested: false,
    reviewers: [],
    conflict: false,
    behind: false,
    checks: [check()],
    ci: 'green',
    threadCount: 0,
    unresolvedCount: 0,
    awaitingYouCount: 0,
    unreadCount: 0,
    resolvedUnreadCount: 0,
    commentAwaitingCount: 0,
    reviewCommentAwaitingCount: 0,
    reviewPending: false,
    threadsTruncated: false,
    linearIssues: [],
    initiativeIds: [],
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
  const writeText = vi.fn(async () => {})
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
            onSetMergeWhenReady={async () => {}}
            queueByKey={new Map()}
            watchesByKey={new Map()}
            holds={new Map()}
            onRerun={async () => ''}
            onStartAgent={async () => ({ url: 'https://example.test' })}
            onRebase={async () => {}}
            byIssue={false}
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
    return [...document.querySelectorAll<HTMLButtonElement>('button.menu-item')].find((item) => item.textContent === text)
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
    expect(menuItem('Copy 1 PR ID')?.textContent).toBe('Copy 1 PR ID')
    await click(menuItem('Copy 1 PR ID'))
    expect(writeText).toHaveBeenLastCalledWith('frontend#1234')
    expect(toastSuccess).toHaveBeenCalledWith('Copied frontend#1234')
  })

  it('reports a clipboard failure', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await render([pull(4685, 'backend')])
    await click(document.querySelector('td.num button'))
    expect(toastError).toHaveBeenCalledWith('Could not copy to the clipboard')
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
