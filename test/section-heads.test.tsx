// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, DEFAULT_SORT, type Check, type PullRequest } from '../src/shared/types.ts'
import { buildOutline, LOOSE_SECTION } from '../src/shared/view.ts'
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

function pull(number: number, linearIssues: PullRequest['linearIssues']): PullRequest {
  const repoName = 'frontend'
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
    linearIssues,
    initiativeIds: [],
  }
}

const issue = (identifier: string, projectName: string | null) => ({
  identifier,
  title: `Issue ${identifier}`,
  url: null,
  projectId: projectName,
  projectName,
})

describe('section headings', () => {
  let root: Root | null = null
  const folded: string[] = []
  const flattened: string[] = []
  const prs = [pull(1, [issue('ENG-1', 'Updates')]), pull(2, [issue('ENG-2', null)]), pull(3, [])]

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    folded.length = 0
    flattened.length = 0
  })

  async function render(flat: string[] = []) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MenuProvider>
          <PrTable
            mode="mine"
            outline={buildOutline(prs, [], DEFAULT_FILTERS, DEFAULT_SORT, 'author', new Set(flat))}
            sort={DEFAULT_SORT}
            initiatives={[]}
            prByKey={new Map(prs.map((pr) => [pr.key, pr]))}
            showRepo={false}
            expanded={new Set()}
            collapsed={new Set()}
            onSort={() => {}}
            onToggle={() => {}}
            onToggleSection={(id) => folded.push(id)}
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
            flat={new Set(flat)}
            onToggleFlat={(id) => flattened.push(id)}
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

  const click = (element: Element | null | undefined) => {
    expect(element).toBeTruthy()
    act(() => (element as HTMLElement).click())
  }
  const project = () => document.querySelector('tr.project')
  const band = (title: string) => [...document.querySelectorAll('tr.band')].find((row) => row.textContent?.includes(title))
  const grouping = (row: Element | null | undefined) => row?.querySelector('button.section-group') ?? undefined

  it('folds a section from its name or its arrow, and not from the rest of the row', async () => {
    await render()
    click(project()?.querySelector('td'))
    click(project()?.querySelector('.section-meta'))
    expect(folded).toEqual([])
    click(project()?.querySelector('.section-title'))
    click(project()?.querySelector('.section-toggle'))
    expect(folded).toEqual(['project:Updates', 'project:Updates'])
  })

  it('offers grouping by issue on each project and on the issues with no project', async () => {
    await render()
    expect(grouping(band('Linear projects'))).toBeUndefined()
    expect(grouping(band('No issue'))).toBeUndefined()
    expect(grouping(project())?.getAttribute('aria-pressed')).toBe('true')
    click(grouping(project()))
    click(grouping(band('Issues with no project')))
    expect(flattened).toEqual(['project:Updates', LOOSE_SECTION])
    expect(folded).toEqual([])
  })

  it('lists a section that is not grouped by issue without issue headings', async () => {
    await render(['project:Updates', LOOSE_SECTION])
    expect(document.querySelectorAll('tr.section')).toHaveLength(0)
    expect(grouping(project())?.getAttribute('aria-pressed')).toBe('false')
    expect(grouping(band('Issues with no project'))?.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelectorAll('td.num')).toHaveLength(3)
  })
})
