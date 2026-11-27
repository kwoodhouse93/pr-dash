import { DEFAULT_FILTERS, DEFAULT_SORT, type CiLevel, type Filters, type Sort, type SortKey } from '../shared/types.ts'
import { DEFAULT_THEME, themeOf, type ThemeId } from '../shared/themes.ts'
import type { PrLinkHost } from './pr-links.tsx'

/** Where the preferences are kept in this browser. index.html reads the theme from it before the page draws. */
export const PREFERENCES_KEY = 'pr-dash.preferences.v1'
const SORT_KEYS = new Set<SortKey>(['updated', 'created', 'size', 'title', 'repo', 'ci'])

export type DashboardPage = 'mine' | 'review' | 'activity' | 'agents' | 'queue' | 'settings'
export type ListPage = 'mine' | 'review'

export type ListPreferences = {
  filters: Filters
  byIssue: boolean
}

export type Preferences = {
  sort: Sort
  views: Record<ListPage, ListPreferences>
  expanded: string[]
  collapsed: string[]
  page: DashboardPage
  prLinks: PrLinkHost
  /** The colour theme. */
  theme: ThemeId
  /** Whether buttons click when pressed. */
  sounds: boolean
  /** Whether a pull request's menu offers to merge it without its required approval. */
  mergeUnapproved: boolean
  /** The T3 Code this browser is paired with, so its threads open in a tab. Null hands them off to the T3 Code app. */
  t3Origin: string | null
  /** False once the user has said not to be offered pairing with T3 Code again. */
  t3PairPrompt: boolean
}

export function loadPreferences(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null') as
      | (Partial<Preferences> & { filters?: Partial<Filters>; byIssue?: boolean })
      | null
    if (!raw) return fresh()
    const key = SORT_KEYS.has(raw.sort?.key as SortKey) ? (raw.sort!.key as SortKey) : DEFAULT_SORT.key
    const dir = raw.sort?.dir === 'asc' || raw.sort?.dir === 'desc' ? raw.sort.dir : DEFAULT_SORT.dir
    const page: DashboardPage = raw.page === 'review' || raw.page === 'activity' || raw.page === 'agents' || raw.page === 'queue' || raw.page === 'settings' ? raw.page : 'mine'
    const legacy = {
      filters: { ...DEFAULT_FILTERS, ...(raw.filters ?? {}) },
      byIssue: raw.byIssue !== false,
    }
    return {
      sort: { key, dir },
      views: {
        mine: loadListPreferences(raw.views?.mine, legacy),
        review: loadListPreferences(raw.views?.review, legacy),
      },
      expanded: Array.isArray(raw.expanded) ? raw.expanded.filter((id) => typeof id === 'string') : [],
      collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((id) => typeof id === 'string') : [],
      page,
      prLinks: raw.prLinks === 'graphite' ? 'graphite' : 'github',
      theme: themeOf(raw.theme).id,
      sounds: raw.sounds !== false,
      mergeUnapproved: raw.mergeUnapproved === true,
      t3PairPrompt: raw.t3PairPrompt !== false,
      t3Origin: typeof raw.t3Origin === 'string' && /^https?:\/\//.test(raw.t3Origin) ? raw.t3Origin : null,
    }
  } catch {
    return fresh()
  }
}

export function savePreferences(prefs: Preferences) {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs))
}

function fresh(): Preferences {
  return {
    sort: DEFAULT_SORT,
    views: {
      mine: { filters: { ...DEFAULT_FILTERS }, byIssue: true },
      review: { filters: { ...DEFAULT_FILTERS }, byIssue: true },
    },
    expanded: [],
    collapsed: [],
    page: 'mine',
    prLinks: 'github',
    theme: DEFAULT_THEME,
    sounds: true,
    mergeUnapproved: false,
    t3Origin: null,
    t3PairPrompt: true,
  }
}

function loadListPreferences(
  raw: Partial<ListPreferences> | undefined,
  fallback: ListPreferences,
): ListPreferences {
  return {
    filters: { ...DEFAULT_FILTERS, ...fallback.filters, ...(raw?.filters ?? {}) },
    byIssue: raw?.byIssue ?? fallback.byIssue,
  }
}

const PAGES = new Set<DashboardPage>(['mine', 'review', 'activity', 'agents', 'queue', 'settings'])
const CI = new Set<CiLevel>(['red', 'yellow', 'green', 'pending', 'none'])
const REVIEW = new Set<Filters['review']>(['unmet', 'met', 'human', 'changes', 'none'])
const FILTER_PARAMS = ['q', 'repo', 'ci', 'review', 'approved', 'initiative', 'awaiting', 'drafts']

/** The address query for the open page and its filters. Anything at its default is left out. */
export function locationSearch(prefs: Preferences): string {
  const params = new URLSearchParams()
  if (prefs.page !== 'mine') params.set('view', prefs.page)
  if (prefs.page === 'mine' || prefs.page === 'review') {
    const filters = prefs.views[prefs.page].filters
    if (filters.query) params.set('q', filters.query)
    if (filters.repo) params.set('repo', filters.repo)
    if (filters.ci !== 'all') params.set('ci', filters.ci)
    if (filters.review !== 'all') params.set('review', filters.review)
    if (filters.approvedByMe !== 'all') params.set('approved', filters.approvedByMe)
    if (filters.initiativeId) params.set('initiative', filters.initiativeId)
    if (filters.awaitingOnly) params.set('awaiting', '1')
    if (filters.hideDrafts) params.set('drafts', 'hide')
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * Saved preferences with the address applied on top. An address that names a page or a filter decides the page.
 * One that names a filter replaces every filter on that page, so a link always opens the same list.
 * A bare address changes nothing.
 */
export function withLocation(prefs: Preferences, search: string): Preferences {
  const params = new URLSearchParams(search)
  const view = params.get('view') as DashboardPage | null
  const filtered = FILTER_PARAMS.some((name) => params.has(name))
  if (!filtered && !(view && PAGES.has(view))) return prefs
  const page = view && PAGES.has(view) ? view : 'mine'
  if (!filtered || (page !== 'mine' && page !== 'review')) return { ...prefs, page }
  const ci = params.get('ci') as CiLevel
  const review = params.get('review') as Filters['review']
  const approved = params.get('approved')
  const filters: Filters = {
    ...DEFAULT_FILTERS,
    query: params.get('q') ?? '',
    repo: params.get('repo') || null,
    ci: CI.has(ci) ? ci : 'all',
    review: REVIEW.has(review) ? review : 'all',
    approvedByMe: approved === 'only' || approved === 'exclude' ? approved : 'all',
    initiativeId: params.get('initiative') || null,
    awaitingOnly: params.get('awaiting') === '1',
    hideDrafts: params.get('drafts') === 'hide',
  }
  return { ...prefs, page, views: { ...prefs.views, [page]: { ...prefs.views[page], filters } } }
}
