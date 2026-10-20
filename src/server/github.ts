import { execFileSync } from 'node:child_process'
import { mapPullRequest, type GitHubPull, type RawCheck } from '../shared/map.ts'
import { requiredCheckNames } from '../shared/rules.ts'
import type { PullRequest } from '../shared/types.ts'

export function loadGithubToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    if (token) return token
  } catch {
    // Fall through to the message below.
  }
  throw new Error('No GitHub token. Set GITHUB_TOKEN, or run gh auth login.')
}

async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pr-dash',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 280)}`)
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '))
  if (!body.data) throw new Error('GitHub query failed')
  return body.data
}

async function rest(token: string, path: string, method = 'GET'): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pr-dash',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(60_000),
  })
}

const LIST_QUERY = `
  query Authored($cursor: String) {
    viewer {
      login
      pullRequests(first: 12, states: [OPEN], after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title url isDraft createdAt updatedAt additions deletions changedFiles
          baseRefName headRefName reviewDecision mergeStateStatus mergeable
          author { login }
          repository { nameWithOwner name }
          reviews(last: 40) { nodes { state submittedAt author { __typename login } } }
          reviewThreads(first: 60) {
            pageInfo { hasNextPage }
            nodes {
              isResolved
              isOutdated
              comments(last: 20) { nodes { author { __typename login } createdAt } }
            }
          }
          comments(first: 12) { nodes { author { __typename login } body } }
        }
      }
    }
  }
`

type ListData = {
  viewer: {
    login: string
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<GitHubPull | null>
    }
  }
}

async function fetchNodes(token: string, onProgress: (message: string) => void): Promise<{ viewer: string; nodes: GitHubPull[] }> {
  const nodes: GitHubPull[] = []
  let cursor: string | null = null
  let viewer = ''
  for (let page = 0; page < 12; page += 1) {
    onProgress(page === 0 ? 'Fetching pull requests' : `Fetching pull requests (${nodes.length} so far)`)
    const data: ListData = await graphql<ListData>(token, LIST_QUERY, { cursor })
    viewer = data.viewer.login
    nodes.push(...data.viewer.pullRequests.nodes.filter((node): node is GitHubPull => node != null))
    if (!data.viewer.pullRequests.pageInfo.hasNextPage) break
    cursor = data.viewer.pullRequests.pageInfo.endCursor
  }
  return { viewer, nodes }
}

type CheckData = Record<string, {
  id?: string
  commits?: { nodes: Array<{ commit: { committedDate: string | null; statusCheckRollup: { contexts: { nodes: Array<RawCheck | null> } } | null } | null } | null> }
} | null>

async function fetchChecks(token: string, ids: string[], onProgress: (message: string) => void) {
  const bundles = new Map<string, { committedAt: string | null; checks: RawCheck[] }>()
  const batchSize = 4
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize)
    onProgress(`Fetching checks ${Math.min(index + batch.length, ids.length)} of ${ids.length}`)
    const varDefs = batch.map((_, number) => `$id${number}: ID!`).join(', ')
    const fields = batch
      .map(
        (_, number) => `
        p${number}: node(id: $id${number}) {
          ... on PullRequest {
            id
            commits(last: 1) {
              nodes {
                commit {
                  committedDate
                  statusCheckRollup {
                    contexts(first: 80) {
                      nodes {
                        __typename
                        ... on CheckRun {
                          name conclusion status detailsUrl startedAt completedAt
                          isRequired(pullRequestId: $id${number})
                          checkSuite { workflowRun { databaseId workflow { name } } }
                        }
                        ... on StatusContext { context state targetUrl createdAt }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      )
      .join('\n')
    const variables = Object.fromEntries(batch.map((id, number) => [`id${number}`, id]))
    const data = await graphql<CheckData>(token, `query Checks(${varDefs}) { ${fields} }`, variables)
    batch.forEach((id, number) => {
      const commit = data[`p${number}`]?.commits?.nodes?.[0]?.commit
      const checks = (commit?.statusCheckRollup?.contexts.nodes ?? []).filter((node): node is RawCheck => node != null)
      bundles.set(id, { committedAt: commit?.committedDate ?? null, checks })
    })
  }
  return bundles
}

async function fetchRequiredNames(token: string, repos: string[], onProgress: (message: string) => void) {
  const names = new Map<string, string[]>()
  for (const repo of repos) {
    onProgress(`Reading required checks for ${repo}`)
    const listResponse = await rest(token, `/repos/${repo}/rulesets?per_page=100`)
    if (!listResponse.ok) {
      names.set(repo, [])
      continue
    }
    const list = (await listResponse.json()) as { id: number }[]
    const rulesets = (
      await Promise.all(
        list.map(async (item) => {
          const response = await rest(token, `/repos/${repo}/rulesets/${item.id}`)
          return response.ok ? response.json() : null
        }),
      )
    ).filter((ruleset) => ruleset != null)
    names.set(repo, requiredCheckNames(rulesets))
  }
  return names
}

export async function fetchAuthoredPullRequests(
  token: string,
  onProgress: (message: string) => void,
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const { viewer, nodes } = await fetchNodes(token, onProgress)
  const repos = [...new Set(nodes.map((node) => node.repository.nameWithOwner))]
  const [bundles, required] = await Promise.all([
    fetchChecks(token, nodes.map((node) => node.id), onProgress),
    fetchRequiredNames(token, repos, onProgress),
  ])
  const warnings: string[] = []
  const pullRequests = nodes.map((node) => {
    const bundle = bundles.get(node.id)
    if (!bundle) warnings.push(`${node.repository.nameWithOwner}#${node.number} is missing checks`)
    return mapPullRequest(node, {
      viewer,
      requiredNames: required.get(node.repository.nameWithOwner) ?? [],
      committedAt: bundle?.committedAt ?? null,
      checks: bundle?.checks ?? [],
    })
  })
  return {
    viewer,
    pullRequests,
    warning: warnings.length ? warnings.slice(0, 3).join('; ') : null,
  }
}

export async function rerunWorkflows(
  token: string,
  runs: { repo: string; runId: number }[],
  mode: 'failed' | 'all',
): Promise<{ reran: number; errors: string[] }> {
  const seen = new Set<string>()
  let reran = 0
  const errors: string[] = []
  for (const run of runs) {
    const key = `${run.repo}#${run.runId}`
    if (seen.has(key)) continue
    seen.add(key)
    const suffix = mode === 'failed' ? 'rerun-failed-jobs' : 'rerun'
    const response = await rest(token, `/repos/${run.repo}/actions/runs/${run.runId}/${suffix}`, 'POST')
    if (response.ok) {
      reran += 1
      continue
    }
    const text = await response.text()
    errors.push(`${run.repo} run ${run.runId}: ${text.slice(0, 180) || response.status}`)
  }
  return { reran, errors }
}
