import type { PullRequest } from './types.ts'

/** GitHub search rejects queries longer than this. */
export const SEARCH_QUERY_LIMIT = 256

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/

export type RepoChoice = {
  name: string
  selected: boolean
  stored: boolean
  busy: boolean
}

export type RepoCatalog = {
  repos: RepoChoice[]
  truncated: boolean
  warning: string | null
}

export function parseRepoName(value: string): string {
  const repo = value.trim()
  const parts = repo.split('/')
  const name = parts[1] ?? ''
  if (parts.length !== 2 || !REPO_PATTERN.test(repo) || name.startsWith('.') || name.endsWith('.') || name.endsWith('.git')) {
    throw new Error('Enter a repository as owner/name.')
  }
  return repo
}

export function pullKeyRepo(key: string): string | null {
  const index = key.lastIndexOf('#')
  if (index <= 0) return null
  const repo = key.slice(0, index)
  return repo.includes('/') ? repo : null
}

/** SQL LIKE pattern for pull request keys of one repository. Escape with `\`. */
export function repoKeyLike(repo: string): string {
  return `${repo.replace(/[\\%_]/g, (char) => `\\${char}`)}#%`
}

/**
 * One search clause per repository, joined with OR, so qualifiers are not dropped
 * by OR precedence. Clauses that cannot fit are omitted. Batches stay within GitHub's limit.
 */
export function scopedQueries(prefix: string, repos: string[], limit = SEARCH_QUERY_LIMIT): string[] {
  const unique = [...new Set(repos)].filter(Boolean).sort()
  const queries: string[] = []
  let batch: string[] = []
  const render = (items: string[]) => items.map((repo) => `${prefix} repo:${repo}`).join(' OR ')
  for (const repo of unique) {
    if (render([repo]).length > limit) continue
    if (batch.length > 0 && render([...batch, repo]).length > limit) {
      queries.push(render(batch))
      batch = []
    }
    batch.push(repo)
  }
  if (batch.length > 0) queries.push(render(batch))
  return queries
}

const AUTHORED_PREFIX = 'sort:updated-desc is:open is:pr archived:false author:@me'

export function authoredSearchQueries(repos: string[]): string[] {
  return scopedQueries(AUTHORED_PREFIX, repos)
}

export function reviewSearchQueries(teams: string[], repos: string[]): string[] {
  const base = 'sort:updated-desc is:open is:pr archived:false -author:@me'
  const prefixes = [
    `${base} review-requested:@me`,
    `${base} reviewed-by:@me`,
    ...teams.map((team) => `${base} team-review-requested:${team}`),
  ]
  return prefixes.flatMap((prefix) => scopedQueries(prefix, repos))
}

/** Replace pull requests for selected repositories and leave every other repository untouched. */
export function replaceRepoPulls(existing: PullRequest[], fetched: PullRequest[], watched: string[]): PullRequest[] {
  const selected = new Set(watched)
  return [
    ...existing.filter((pr) => !selected.has(pr.repo)),
    ...fetched.filter((pr) => selected.has(pr.repo)),
  ]
}

export function removalWarning(repo: string, stored: boolean, busy: boolean): { title: string; body: string; confirm: string | null } {
  if (busy) {
    return {
      title: `A merge is still running for ${repo}`,
      body: `Cancel that merge on the Queue page before removing ${repo}. Removing it would delete the queue entry while the merge is in progress.`,
      confirm: null,
    }
  }
  if (stored) {
    return {
      title: `Remove ${repo}?`,
      body: `This deletes pull requests, cached rules, agent sessions, and merge queue entries stored for ${repo}. GitHub is not changed. You can add the repository again later, and the next refresh loads it from scratch.`,
      confirm: 'Remove repository',
    }
  }
  return {
    title: `Remove ${repo}?`,
    body: `Refreshes will stop including ${repo}. Nothing is stored for it yet.`,
    confirm: 'Remove repository',
  }
}
