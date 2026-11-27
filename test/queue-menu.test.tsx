// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { summarize } from '../src/shared/stacks.ts'
import type { PullRequest } from '../src/shared/types.ts'
import type { Outline } from '../src/shared/view.ts'
import { MenuProvider } from '../src/web/menus.tsx'
import { PrTable } from '../src/web/table.tsx'
import { pullRequest } from './support/pull.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function pull(): PullRequest {
  return {
    ...pullRequest(7),
    id: 'pr-7',
    key: 'acme/app#7',
    repo: 'acme/app',
    repoName: 'app',
    number: 7,
    title: 'Ship the queue',
    url: 'https://github.com/acme/app/pull/7',
    headRef: 'queue',
    reviewers: [{ login: 'ada', human: true, state: 'APPROVED', submittedAt: '2026-10-02T01:00:00Z' }],
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
          parents: { [pr.key]: null },
          collapsible: false,
          summary: summarize([pr], false),
          rows: [{ type: 'pr', pr }],
        },
      ],
    },
  }
}

describe('merge action', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function render(
    onMerge: (key: string) => Promise<void>,
    options: {
      pr?: Partial<PullRequest>
      onMergeUnapproved?: (key: string) => Promise<void>
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
            showRepo={false}
            expanded={new Set()}
            collapsed={new Set()}
            onSort={() => {}}
            onToggle={() => {}}
            onToggleSection={() => {}}
            onAssign={async () => {}}
            onCreateAssigned={async () => {}}
            onMerge={onMerge}
            onMergeUnapproved={options.onMergeUnapproved}
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
    return pr
  }

  it('queues the pull request when Merge is pressed, with no second action to choose', async () => {
    const queued: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await render(async (key) => {
      queued.push(key)
      await gate
    })
    expect(document.querySelector('button[aria-label="More merge actions for #7"]')).toBeNull()
    const merge = document.querySelector<HTMLButtonElement>('button[aria-label="Squash and merge #7"]')
    expect(merge?.textContent).toBe('Merge')
    await act(async () => {
      merge!.click()
    })
    expect(queued).toEqual(['acme/app#7'])
    expect(document.body.textContent).toContain('Queuing')
    await act(async () => release())
  })

  const unapproved: Partial<PullRequest> = { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', mergeMark: 'unmet', reviewers: [] }

  async function openRowMenu() {
    await act(async () => {
      document.querySelector<HTMLElement>('button.row-menu')!.click()
    })
    return [...document.querySelectorAll<HTMLButtonElement>('button.menu-item')]
  }

  it('offers to merge without approval only when that is turned on', async () => {
    await render(async () => {}, { pr: unapproved })
    expect((await openRowMenu()).some((item) => item.getAttribute('aria-label')?.includes('without approval'))).toBe(false)
  })

  it('does not offer to merge an approved pull request without approval', async () => {
    await render(async () => {}, { onMergeUnapproved: async () => {} })
    expect((await openRowMenu()).some((item) => item.getAttribute('aria-label')?.includes('without approval'))).toBe(false)
  })

  it('queues a merge without approval after a second press', async () => {
    const queued: string[] = []
    await render(async () => {}, {
      pr: unapproved,
      onMergeUnapproved: async (key) => {
        queued.push(key)
      },
    })
    const item = () => document.querySelector<HTMLButtonElement>('button.menu-item[aria-label="Merge #7 without approval…"]')
    const confirm = () => document.querySelector<HTMLButtonElement>('.menu-confirm button.danger')
    await openRowMenu()
    expect(confirm()).toBeNull()
    await act(async () => item()!.click())
    expect(queued).toEqual([])
    expect(item()).toBeNull()
    expect(document.querySelector('.menu-confirm h4')?.textContent).toBe('Merge #7 without approval?')

    // Cancel puts the line back, and nothing is queued.
    await act(async () => document.querySelector<HTMLButtonElement>('.menu-confirm button.ghost')!.click())
    expect(confirm()).toBeNull()
    expect(queued).toEqual([])

    await act(async () => item()!.click())
    await act(async () => confirm()!.click())
    expect(queued).toEqual(['acme/app#7'])
    expect(document.querySelector('.popover')).toBeNull()
  })
})
