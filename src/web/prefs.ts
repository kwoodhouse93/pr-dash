import { DEFAULT_FILTERS, DEFAULT_SORT, type Filters, type Sort, type SortKey } from '../shared/types.ts'

const KEY = 'pr-dash.preferences.v1'
const SORT_KEYS = new Set<SortKey>(['updated', 'created', 'size', 'title', 'repo', 'ci'])

export type Preferences = {
  sort: Sort
  filters: Filters
  expanded: string[]
}

export function loadPreferences(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Preferences> | null
    if (!raw) return fresh()
    const key = SORT_KEYS.has(raw.sort?.key as SortKey) ? (raw.sort!.key as SortKey) : DEFAULT_SORT.key
    const dir = raw.sort?.dir === 'asc' || raw.sort?.dir === 'desc' ? raw.sort.dir : DEFAULT_SORT.dir
    return {
      sort: { key, dir },
      filters: { ...DEFAULT_FILTERS, ...(raw.filters ?? {}) },
      expanded: Array.isArray(raw.expanded) ? raw.expanded.filter((id) => typeof id === 'string') : [],
    }
  } catch {
    return fresh()
  }
}

export function savePreferences(prefs: Preferences) {
  localStorage.setItem(KEY, JSON.stringify(prefs))
}

function fresh(): Preferences {
  return { sort: DEFAULT_SORT, filters: DEFAULT_FILTERS, expanded: [] }
}
