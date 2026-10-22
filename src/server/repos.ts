import type { RepoCatalog } from '../shared/repos.ts'
import type { DashboardDb } from './db.ts'
import { listAccessibleRepos, loadGithubToken } from './github.ts'

export async function repoCatalog(db: DashboardDb): Promise<RepoCatalog> {
  const selected = new Set(db.watchedRepos())
  const stored = new Set(db.storedRepos())
  let available: string[] = []
  let truncated = false
  let warning: string | null = null
  try {
    const listed = await listAccessibleRepos(loadGithubToken())
    available = listed.names
    truncated = listed.truncated
  } catch (error) {
    warning = error instanceof Error ? error.message : 'Could not list repositories.'
  }
  const names = [...new Set([...selected, ...stored, ...available])].sort((left, right) => left.localeCompare(right))
  return {
    viewer: db.snapshot().viewer,
    truncated,
    warning,
    repos: names.map((name) => ({
      name,
      selected: selected.has(name),
      stored: stored.has(name),
      busy: db.queue.repoActive(name),
    })),
  }
}
