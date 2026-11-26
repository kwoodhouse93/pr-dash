import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Filters, Initiative, PullRequest } from '../shared/types.ts'
import { prMatches } from '../shared/view.ts'
import { ClickCard, PopBody, PopHead, useMenuClose } from './menus.tsx'
import type { ListPage } from './prefs.ts'

type Option<T> = { value: T; label: string; count: number }

const CI_LABELS: [Filters['ci'], string][] = [
  ['all', 'Any'],
  ['red', 'Required failed'],
  ['yellow', 'Optional failed'],
  ['pending', 'Running'],
  ['green', 'Passed'],
  ['none', 'No CI'],
]

const REVIEW_LABELS: [Filters['review'], string][] = [
  ['all', 'Any'],
  ['unmet', 'Review required'],
  ['met', 'Requirements met'],
  ['human', 'Human approved'],
  ['changes', 'Changes requested'],
  ['none', 'No approval'],
]

const APPROVAL_LABELS: [Filters['approvedByMe'], string][] = [
  ['all', 'Either'],
  ['only', 'Approved'],
  ['exclude', 'Not approved'],
]

function labelOf<T>(labels: [T, string][], value: T): string {
  return labels.find(([key]) => key === value)?.[1] ?? String(value)
}

function repoLabel(repo: string): string {
  return repo.split('/')[1] ?? repo
}

function awaitingLabel(page: ListPage): string {
  return page === 'review' ? 'Unread' : 'Awaiting you'
}

/** One phrase for each filter that is set, in the order the bar shows them. */
export function activeFilterLabels(filters: Filters, page: ListPage, initiatives: Initiative[]): string[] {
  const labels: string[] = []
  const query = filters.query.trim()
  if (query) labels.push(`search “${query}”`)
  if (filters.repo) labels.push(`repo ${repoLabel(filters.repo)}`)
  if (filters.ci !== 'all') labels.push(`CI: ${labelOf(CI_LABELS, filters.ci)}`)
  if (filters.review !== 'all') labels.push(`review: ${labelOf(REVIEW_LABELS, filters.review)}`)
  if (filters.approvedByMe !== 'all') labels.push(`your approval: ${labelOf(APPROVAL_LABELS, filters.approvedByMe)}`)
  if (filters.initiativeId === 'none') labels.push('initiative: Untagged')
  else if (filters.initiativeId) {
    const name = initiatives.find((initiative) => initiative.id === filters.initiativeId)?.name
    labels.push(`initiative: ${name ?? 'one that no longer exists'}`)
  }
  if (filters.awaitingOnly) labels.push(awaitingLabel(page))
  if (filters.hideDrafts) labels.push('Hide drafts')
  return labels
}

export function FilterBar({
  page,
  filters,
  filtersOn,
  byIssue,
  prs,
  repos,
  initiatives,
  viewer,
  matched,
  onPatch,
  onClear,
  onByIssue,
  onManageInitiatives,
}: {
  page: ListPage
  filters: Filters
  filtersOn: boolean
  byIssue: boolean
  prs: PullRequest[]
  repos: string[]
  initiatives: Initiative[]
  viewer: string | null
  matched: number
  onPatch: (patch: Partial<Filters>) => void
  onClear: () => void
  onByIssue: (next: boolean) => void
  onManageInitiatives: () => void
}) {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Each option's count is what the list would hold with that option picked and every other filter left as it is. */
  const options = useMemo(() => {
    const names = new Map(initiatives.map((initiative) => [initiative.id, initiative.name]))
    const attention = page === 'review' ? 'reviewer' : 'author'
    const count = (patch: Partial<Filters>) =>
      prs.filter((pr) => prMatches(pr, { ...filters, ...patch }, names, attention, viewer)).length
    return {
      repo: [
        { value: null, label: 'Any', count: count({ repo: null }) },
        ...repos.map((repo) => ({ value: repo, label: repoLabel(repo), count: count({ repo }) })),
      ] as Option<string | null>[],
      ci: CI_LABELS.map(([value, label]) => ({ value, label, count: count({ ci: value }) })),
      review: REVIEW_LABELS.map(([value, label]) => ({ value, label, count: count({ review: value }) })),
      approvedByMe: APPROVAL_LABELS.map(([value, label]) => ({ value, label, count: count({ approvedByMe: value }) })),
      initiative: [
        { value: null, label: 'Any', count: count({ initiativeId: null }) },
        { value: 'none', label: 'Untagged', count: count({ initiativeId: 'none' }) },
        ...initiatives.map((initiative) => ({
          value: initiative.id,
          label: initiative.name,
          count: count({ initiativeId: initiative.id }),
        })),
      ] as Option<string | null>[],
      awaiting: count({ awaitingOnly: true }),
    }
  }, [prs, repos, initiatives, filters, page, viewer])

  const noun = page === 'review' ? 'to review' : 'open'

  return (
    <div className="filters">
      <label className="search-box">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="m10.5 10.5 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={filters.query}
          onChange={(event) => onPatch({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            if (filters.query) onPatch({ query: '' })
            else event.currentTarget.blur()
          }}
          placeholder={page === 'review' ? 'Search title, author, repo, number, issue' : 'Search title, repo, number, issue'}
          aria-label="Search pull requests"
          aria-keyshortcuts="/"
        />
        {filters.query ? (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onPatch({ query: '' })}>
            ×
          </button>
        ) : (
          <kbd aria-hidden="true">/</kbd>
        )}
      </label>
      <div className="filter-group" role="group" aria-label="Filters">
        <span className="filter-label" aria-hidden="true">Filter</span>
        <FilterChip id="repo" label="Repo" value={filters.repo} options={options.repo} onPick={(repo) => onPatch({ repo })} />
        <FilterChip id="ci" label="CI" value={filters.ci} options={options.ci} onPick={(ci) => onPatch({ ci })} />
        <FilterChip id="review" label="Review" value={filters.review} options={options.review} onPick={(review) => onPatch({ review })} />
        {page === 'review' ? (
          <FilterChip
            id="approval"
            label="Your approval"
            value={filters.approvedByMe}
            options={options.approvedByMe}
            onPick={(approvedByMe) => onPatch({ approvedByMe })}
          />
        ) : null}
        <FilterChip
          id="initiative"
          label="Initiative"
          value={filters.initiativeId}
          options={options.initiative}
          onPick={(initiativeId) => onPatch({ initiativeId })}
          footer={{ label: 'Manage initiatives in Settings', onClick: onManageInitiatives }}
        />
        <span className="filter-rule" aria-hidden="true" />
        <button
          type="button"
          className="chip"
          aria-pressed={filters.awaitingOnly}
          onClick={() => onPatch({ awaitingOnly: !filters.awaitingOnly })}
        >
          {awaitingLabel(page)}
          <span className="chip-count">{options.awaiting}</span>
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={filters.hideDrafts}
          onClick={() => onPatch({ hideDrafts: !filters.hideDrafts })}
        >
          Hide drafts
        </button>
        {filtersOn ? (
          <button type="button" className="text-btn" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="filter-view">
        <span className="filter-count">
          {filtersOn ? (
            <>
              <strong>{matched}</strong> of {prs.length} {noun}
            </>
          ) : (
            <>
              <strong>{prs.length}</strong> {noun}
            </>
          )}
        </span>
        <span className="filter-rule" aria-hidden="true" />
        <button
          type="button"
          className="chip view"
          aria-pressed={byIssue}
          title="Group pull requests under each Linear issue. Projects and initiatives stay either way."
          onClick={() => onByIssue(!byIssue)}
        >
          Group by issue
        </button>
      </div>
    </div>
  )
}

function FilterChip<T extends string | null>({
  id,
  label,
  value,
  options,
  onPick,
  footer,
}: {
  id: string
  label: string
  value: T
  /** The first option is the one that leaves this filter off. */
  options: Option<T>[]
  onPick: (value: T) => void
  footer?: { label: string; onClick: () => void }
}) {
  const wrap = useRef<HTMLSpanElement>(null)
  const off = options[0]!.value
  const active = value !== off
  const current = options.find((option) => option.value === value)
  const pick = (next: T) => {
    onPick(next)
    wrap.current?.querySelector('button')?.focus()
  }
  return (
    <span ref={wrap} className="chip" data-on={active || undefined}>
      <ClickCard
        id={`filter-${id}`}
        className="chip-btn"
        panelClassName="filter-menu"
        label={
          active ? (
            <>
              <span className="chip-key">{label}</span>
              {current?.label ?? 'Unknown'}
            </>
          ) : (
            <>
              {label}
              <svg className="chip-caret" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          )
        }
      >
        <FilterOptions label={label} value={value} options={options} onPick={pick} footer={footer} />
      </ClickCard>
      {active ? (
        <button type="button" className="chip-x" aria-label={`Clear ${label} filter`} onClick={() => pick(off)}>
          ×
        </button>
      ) : null}
    </span>
  )
}

function FilterOptions<T extends string | null>({
  label,
  value,
  options,
  onPick,
  footer,
}: {
  label: string
  value: T
  options: Option<T>[]
  onPick: (value: T) => void
  footer?: { label: string; onClick: () => void }
}) {
  const close = useMenuClose()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [])

  let foot: ReactNode = null
  if (footer) {
    foot = (
      <div className="filter-menu-foot">
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            close()
            footer.onClick()
          }}
        >
          {footer.label}
        </button>
      </div>
    )
  }

  return (
    <>
      <PopHead title={label} />
      <PopBody list>
    <div ref={list} role="menu" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value ?? ''}
          type="button"
          role="menuitemradio"
          aria-checked={option.value === value}
          className="menu-item filter-option"
          data-empty={option.count === 0 || undefined}
          onClick={() => {
            close()
            onPick(option.value)
          }}
        >
          <span>{option.label}</span>
          <span className="option-count">{option.count}</span>
        </button>
      ))}
      {foot}
    </div>
      </PopBody>
    </>
  )
}
