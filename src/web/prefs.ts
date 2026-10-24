import { DEFAULT_FILTERS, DEFAULT_SORT, type Filters, type Sort, type SortKey } from '../shared/types.ts'
import type { PrLinkHost } from './pr-links.tsx'

const KEY = 'pr-dash.preferences.v1'
const SORT_KEYS = new Set<SortKey>(['updated', 'created', 'size', 'title', 'repo', 'ci'])

export type DashboardPage = 'mine' | 'review' | 'queue' | 'settings'
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
}

export function loadPreferences(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as
      | (Partial<Preferences> & { filters?: Partial<Filters>; byIssue?: boolean })
      | null
    if (!raw) return fresh()
    const key = SORT_KEYS.has(raw.sort?.key as SortKey) ? (raw.sort!.key as SortKey) : DEFAULT_SORT.key
    const dir = raw.sort?.dir === 'asc' || raw.sort?.dir === 'desc' ? raw.sort.dir : DEFAULT_SORT.dir
    const page: DashboardPage = raw.page === 'review' || raw.page === 'queue' || raw.page === 'settings' ? raw.page : 'mine'
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
    }
  } catch {
    return fresh()
  }
}

export function savePreferences(prefs: Preferences) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
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
