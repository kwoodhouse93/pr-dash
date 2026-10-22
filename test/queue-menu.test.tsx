// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { summarize } from '../src/shared/stacks.ts'
import type { Check, PullRequest } from '../src/shared/types.ts'
import type { Outline } from '../src/shared/view.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { PrTable } from '../src/web/table.tsx'

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

function pull(): PullRequest {
  return {
    id: 'pr-7',
    key: 'acme/app#7',
    repo: 'acme/app',
    repoName: 'app',
    number: 7,
    title: 'Ship the queue',
    url: 'https://github.com/acme/app/pull/7',
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
    headRef: 'queue',
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
    reviewers: [{ login: 'ada', human: true, state: 'APPROVED', submittedAt: '2026-10-02T01:00:00Z' }],
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

function outlineFor(pr: PullRequest): Outline {
  return {
    projects: [],
    initiatives: [],
    looseIssues: [],
    unassigned: {
      id: 'unassigned',
      title: null,
      href: null,
      meta: null,
      count: 1,
      issueId: null,
      stacks: [],
      singles: [
        {
          id: 'only',
          stackKeys: [pr.key],
          collapsible: false,
          summary: summarize([pr], false),
          rows: [{ type: 'pr', pr }],
        },
      ],
    },
  }
}

describe('queue menu', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function render(
    onQueue: (key: string) => Promise<void>,
    options: {
      pr?: Partial<PullRequest>
      onSetMergeWhenReady?: (key: string, scope: 'pr' | 'downstack', enabled: boolean) => Promise<void>
    } = {},
  ) {
    const pr = { ...pull(), ...options.pr }
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MenuProvider>
          <PrTable
            mode="mine"
            outline={outlineFor(pr)}
            sort={{ key: 'updated', dir: 'desc' }}
            initiatives={[]}
            prByKey={new Map([[pr.key, pr]])}
            repoColor={new Map()}
            expanded={new Set()}
            collapsed={new Set()}
            onSort={() => {}}
            onToggle={() => {}}
            onToggleSection={() => {}}
            onAssign={async () => {}}
            onCreateAssigned={async () => {}}
            onMerge={async () => {}}
            onQueue={onQueue}
            onStackMerge={async () => {}}
            onMarkReady={async () => {}}
            onSetMergeWhenReady={options.onSetMergeWhenReady ?? (async () => {})}
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
            viewer={null}
            onFeedback={() => {}}
          />
        </MenuProvider>,
      )
    })
    return pr
  }

  async function openMenu() {
    const caret = document.querySelector<HTMLButtonElement>('button[aria-label="More merge actions for #7"]')
    expect(caret).not.toBeNull()
    await act(async () => {
      caret!.click()
    })
    const item = document.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    expect(item?.textContent).toBe('Queue')
    return item!
  }

  it('queues the pull request when Queue is pressed', async () => {
    const queued: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await render(async (key) => {
      queued.push(key)
      await gate
    })
    const item = await openMenu()
    await act(async () => {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(item.isConnected).toBe(true)
    await act(async () => {
      item.click()
    })
    expect(queued).toEqual(['acme/app#7'])
    expect(document.body.textContent).toContain('Queuing')
    await act(async () => release())
  })

  it('closes the menu on an outside press without queueing', async () => {
    const queued: string[] = []
    await render(async (key) => {
      queued.push(key)
    })
    await openMenu()
    await act(async () => {
      document.documentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('button[role="menuitem"]')).toBeNull()
    expect(queued).toEqual([])
  })

  it('offers merge when ready while a pull request is not mergeable', async () => {
    const changes: [string, string, boolean][] = []
    await render(async () => {}, {
      pr: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      onSetMergeWhenReady: async (key, scope, enabled) => {
        changes.push([key, scope, enabled])
      },
    })
    const toggle = document.querySelector<HTMLInputElement>('label.merge-ready-toggle input')
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle!.click()
    })
    expect(changes).toEqual([['acme/app#7', 'pr', true]])
  })
})
