// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, type CiLevel, type Filters, type PullRequest } from '../src/shared/types.ts'
import { prMatches } from '../src/shared/view.ts'
import { FilterBar, activeFilterLabels } from '../src/web/filter-bar.tsx'
import { MenuProvider } from '../src/web/menus.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function pull(number: number, repoName: string, ci: CiLevel, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr-${number}`,
    key: `acme/${repoName}#${number}`,
    repo: `acme/${repoName}`,
    repoName,
    number,
    title: `Change ${number}`,
    author: 'ada',
    headRef: `branch-${number}`,
    isDraft: false,
    ci,
    mergeMark: 'unmet',
    anyApproval: false,
    humanApproval: false,
    changesRequested: false,
    reviewers: [],
    initiativeIds: [],
    linearIssues: [],
    awaitingYouCount: 0,
    ...over,
  } as unknown as PullRequest
}

const PRS = [
  pull(1, 'api', 'red', { awaitingYouCount: 1 }),
  pull(2, 'api', 'red'),
  pull(3, 'api', 'green'),
  pull(4, 'web', 'red'),
]

let latest: Filters = DEFAULT_FILTERS

function Harness({ start }: { start: Filters }) {
  const [filters, setFilters] = useState(start)
  latest = filters
  const names = new Map<string, string>()
  return (
    <MenuProvider>
      <FilterBar
        page="mine"
        filters={filters}
        filtersOn={JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)}
        prs={PRS}
        repos={['acme/api', 'acme/web']}
        initiatives={[]}
        viewer="ada"
        matched={PRS.filter((pr) => prMatches(pr, filters, names, 'author', 'ada')).length}
        onPatch={(patch) => setFilters((current) => ({ ...current, ...patch }))}
        onClear={() => setFilters(DEFAULT_FILTERS)}
        onManageInitiatives={() => {}}
      />
    </MenuProvider>
  )
}

describe('filter bar', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function mount(start: Filters = DEFAULT_FILTERS) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<Harness start={start} />))
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.replace(/\s+/g, ' ').trim() === text)
    if (!found) throw new Error(`No button reads "${text}"`)
    return found
  }

  function click(element: HTMLElement) {
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('counts each option against the other filters, and shows the pick on the chip', () => {
    mount({ ...DEFAULT_FILTERS, repo: 'acme/api' })
    click(button('CI'))
    const options = [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)
    expect(options).toEqual(['Any3', 'Required failed2', 'Optional failed0', 'Running0', 'Passed1', 'No CI0'])

    click(button('Required failed2'))
    expect(latest.ci).toBe('red')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('.filter-count')?.textContent).toBe('2 of 4 open')
    expect(button('Awaiting you1')).toBeTruthy()

    click(document.querySelector<HTMLElement>('[aria-label="Clear CI filter"]')!)
    expect(latest.ci).toBe('all')
    expect(latest.repo).toBe('acme/api')

    click(button('Clear'))
    expect(latest).toEqual(DEFAULT_FILTERS)
    expect(document.querySelector('.filter-count')?.textContent).toBe('4 open')
  })

  it('closes an open menu on a click elsewhere', () => {
    mount()
    click(button('Repo'))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('focuses search on slash, and escape clears it', () => {
    mount({ ...DEFAULT_FILTERS, query: 'hook' })
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search pull requests"]')!
    expect(document.activeElement).not.toBe(input)

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(input)

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(latest.query).toBe('')
  })

  it('names the filters that are set', () => {
    expect(
      activeFilterLabels(
        { ...DEFAULT_FILTERS, query: ' hook ', repo: 'acme/api', ci: 'red', initiativeId: 'i1', awaitingOnly: true },
        'review',
        [{ id: 'i1', name: 'Cleanup' } as never],
      ),
    ).toEqual(['search “hook”', 'repo api', 'CI: Required failed', 'initiative: Cleanup', 'Unread'])
  })
})
