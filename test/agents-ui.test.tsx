// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../src/shared/agents.ts'
import { summarize } from '../src/shared/stacks.ts'
import type { Check, CursorSession, PullRequest } from '../src/shared/types.ts'
import type { Outline } from '../src/shared/view.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { PrTable } from '../src/web/table.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function check(conclusion: string): Check {
  return {
    name: 'Check',
    status: 'COMPLETED',
    conclusion,
    required: true,
    url: null,
    workflowName: 'CI',
    workflowRunId: 3,
    startedAt: '2026-10-20T12:00:00Z',
    completedAt: '2026-10-20T12:05:00Z',
  }
}

function session(patch: Partial<CursorSession>): CursorSession {
  return {
    agentId: 'bc-1',
    runId: 'run-1',
    kind: 'conflict',
    prompt: null,
    status: 'running',
    result: null,
    branch: null,
    createdAt: '2026-10-20T12:00:00Z',
    updatedAt: '2026-10-20T12:00:00Z',
    ...patch,
  }
}

function pull(patch: Partial<PullRequest> = {}): PullRequest {
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
    reviewers: [],
    conflict: false,
    behind: false,
    checks: [check('SUCCESS')],
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
    cursorSessions: [],
    ...patch,
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
      singles: [{ id: 'only', stackKeys: [pr.key], parents: { [pr.key]: null }, collapsible: false, summary: summarize([pr], false), rows: [{ type: 'pr', pr }] }],
    },
  }
}

describe('agents', () => {
  let root: Root | null = null
  let opened: string[] = []

  beforeEach(() => {
    opened = []
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
    vi.unstubAllGlobals()
  })

  async function render(
    pr: PullRequest,
    onStartAgent: (key: string, request: AgentRequest) => Promise<{ url: string }> = async () => ({ url: '' }),
    options: { linearConfigured?: boolean; onLinkIssue?: (key: string, identifier: string) => Promise<void> } = {},
  ) {
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
            showRepo={false}
            expanded={new Set()}
            collapsed={new Set()}
            onSort={() => {}}
            onToggle={() => {}}
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
            onStartAgent={onStartAgent}
            onRebase={async () => {}}
            byIssue={false}
            onRefreshPr={async () => {}}
            linearConfigured={options.linearConfigured ?? false}
            onUpdateIssue={async () => {}}
            onLinkIssue={options.onLinkIssue ?? (async () => {})}
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

  function button(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(text))
  }

  it('shows a single session as a count colored by its status', async () => {
    await render(pull({ conflict: true, cursorSessions: [session({ result: 'Merged main in.' })] }))
    const chip = document.querySelector('td.agents .cursor-chip')
    expect(chip?.querySelector('[aria-hidden]')?.textContent).toBe('1')
    expect(chip?.querySelector('.sr')?.textContent).toBe('Cursor agent, Merge conflict, Running')
    expect(chip?.className).toContain('running')
    expect(document.querySelector('td.conflict .cursor-chip')).toBeNull()
    await click(chip)
    expect(document.querySelector('.popover')?.textContent).toContain('Merge conflict · Running')
    expect(document.querySelector('.popover')?.textContent).toContain('Merged main in.')
  })

  it('counts several sessions and lists each one', async () => {
    await render(
      pull({
        cursorSessions: [
          session({ agentId: 'bc-3', kind: 'prompt', prompt: 'Rename the helper', createdAt: '2026-10-20T14:00:00Z' }),
          session({ agentId: 'bc-2', kind: 'ci', status: 'finished', result: 'Fixed lint.', createdAt: '2026-10-20T13:00:00Z' }),
          session({ agentId: 'bc-1', status: 'failed' }),
        ],
      }),
    )
    const chip = document.querySelector('td.agents .cursor-chip')
    expect(chip?.querySelector('[aria-hidden]')?.textContent).toBe('3')
    expect(chip?.className).toContain('running')
    await click(chip)
    const headings = [...document.querySelectorAll('.popover .cursor-session h3')].map((item) => item.textContent)
    expect(headings).toEqual(['Prompt · Running', 'CI failure · Finished', 'Merge conflict · Failed'])
    expect(document.querySelector('.popover .agent-prompt')?.textContent).toBe('Rename the helper')
    expect(document.querySelector('.popover details summary')?.textContent).toBe('Final reply')
  })

  it('starts an agent from a prompt in the row menu', async () => {
    const started: { key: string; request: AgentRequest }[] = []
    await render(pull(), async (key, request) => {
      started.push({ key, request })
      return { url: 'https://cursor.com/agents/bc-9' }
    })
    await click(document.querySelector('button.row-menu'))
    expect(button('Investigate CI failure')).toBeUndefined()
    await click(button('Work on #7 with Cursor'))
    const textarea = document.querySelector<HTMLTextAreaElement>('.agent-form textarea')!
    expect(button('Start agent')?.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Split the helper out')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Start agent'))
    expect(started).toEqual([{ key: 'acme/app#7', request: { kind: 'prompt', prompt: 'Split the helper out' } }])
    expect(opened).toEqual(['https://cursor.com/agents/bc-9'])
    expect(document.querySelector('.agent-form')).toBeNull()
  })

  it('offers the CI shortcut when a check failed', async () => {
    const started: AgentRequest[] = []
    await render(pull({ checks: [check('FAILURE')], ci: 'red' }), async (_key, request) => {
      started.push(request)
      return { url: 'https://cursor.com/agents/bc-4' }
    })
    await click(document.querySelector('button.row-menu'))
    await click(button('Investigate CI failure on #7'))
    expect(started).toEqual([{ kind: 'ci' }])
    expect(opened).toEqual(['https://cursor.com/agents/bc-4'])
  })

  it('links a Linear issue from the row menu', async () => {
    const linked: { key: string; identifier: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        if (url.includes('/api/linear/issues')) {
          return new Response(
            JSON.stringify({ issues: [{ identifier: 'ENG-12', title: 'Login', url: 'https://linear.app/acme/issue/ENG-12' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 404 })
      }),
    )
    await render(pull(), async () => ({ url: '' }), {
      linearConfigured: true,
      onLinkIssue: async (key, identifier) => {
        linked.push({ key, identifier })
      },
    })
    await click(document.querySelector('button.row-menu'))
    await click(button('Link Linear issue'))
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find a Linear issue"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ENG-12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('ENG-12')).toBeTruthy()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    await click(button('ENG-12 · Login'))
    expect(linked).toEqual([{ key: 'acme/app#7', identifier: 'ENG-12' }])
    expect(document.querySelector('.link-issue')).toBeNull()
  })

  it('holds the CI shortcut while one is already running', async () => {
    await render(pull({ checks: [check('FAILURE')], ci: 'red', cursorSessions: [session({ kind: 'ci' })] }))
    await click(document.querySelector('button.row-menu'))
    expect(button('Cursor is investigating CI on #7')?.disabled).toBe(true)
  })
})
