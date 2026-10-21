import { execFileSync } from 'node:child_process'
import { checksFromRaw, mapPullRequest, type GitHubPull, type RawCheck } from '../shared/map.ts'
import type { LivePull } from '../shared/queue.ts'
import { requiredCheckNames, reviewPolicy } from '../shared/rules.ts'
import type { PullRequest } from '../shared/types.ts'
import { summarizeReviews } from '../shared/approval.ts'

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

async function rest(token: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pr-dash',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
}

const PULL_FIELDS = `
  id number title url isDraft createdAt updatedAt additions deletions changedFiles
  baseRefName headRefName reviewDecision mergeStateStatus mergeable
  author { login avatarUrl }
  repository { nameWithOwner name squashMergeAllowed defaultBranchRef { name } }
  reviews(last: 40) { nodes { state submittedAt body author { __typename login } } }
  reviewThreads(first: 60) {
    pageInfo { hasNextPage }
    nodes {
      isResolved
      isOutdated
      resolvedBy { login }
      comments(last: 30) { nodes { author { __typename login } createdAt url } }
    }
  }
  comments(first: 12) { nodes { author { __typename login } body } }
  latestComments: comments(last: 20) { nodes { author { __typename login } createdAt body } }
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { combinedSlug }
      }
    }
  }
`

const LIST_QUERY = `
  query Authored($cursor: String) {
    viewer {
      login
      pullRequests(first: 12, states: [OPEN], after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PULL_FIELDS} }
      }
    }
  }
`

const SEARCH_QUERY = `
  query Review($query: String!, $cursor: String) {
    search(query: $query, type: ISSUE, first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PULL_FIELDS} } }
    }
  }
`

const VIEWER_QUERY = `query Viewer { viewer { login } }`

const TEAMS_QUERY = `
  query Teams($login: String!) {
    viewer {
      organizations(first: 15) {
        nodes {
          teams(first: 30, userLogins: [$login]) {
            nodes { combinedSlug }
          }
        }
      }
    }
  }
`

export function reviewSearchQueries(teams: string[]): string[] {
  const base = 'is:open is:pr archived:false -author:@me'
  return [
    `${base} review-requested:@me`,
    `${base} reviewed-by:@me`,
    ...teams.map((team) => `${base} team-review-requested:${team}`),
  ]
}

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
    onProgress(page === 0 ? 'Fetching your pull requests' : `Fetching your pull requests (${nodes.length} so far)`)
    const data: ListData = await graphql<ListData>(token, LIST_QUERY, { cursor })
    viewer = data.viewer.login
    nodes.push(...data.viewer.pullRequests.nodes.filter((node): node is GitHubPull => node != null))
    if (!data.viewer.pullRequests.pageInfo.hasNextPage) break
    cursor = data.viewer.pullRequests.pageInfo.endCursor
  }
  return { viewer, nodes }
}

type SearchData = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: Array<GitHubPull | null> | null
  }
}

type TeamsData = {
  viewer: {
    organizations: {
      nodes: Array<{ teams: { nodes: Array<{ combinedSlug: string } | null> | null } } | null> | null
    } | null
  }
}

async function viewerContext(token: string): Promise<{ login: string; teams: string[]; warning: string | null }> {
  const viewer = await graphql<{ viewer: { login: string } }>(token, VIEWER_QUERY)
  const login = viewer.viewer.login
  try {
    const data = await graphql<TeamsData>(token, TEAMS_QUERY, { login })
    const teams = (data.viewer.organizations?.nodes ?? []).flatMap((org) =>
      (org?.teams.nodes ?? []).flatMap((team) => (team?.combinedSlug ? [team.combinedSlug] : [])),
    )
    return { login, teams: [...new Set(teams)], warning: null }
  } catch {
    return { login, teams: [], warning: 'Team review requests were not loaded.' }
  }
}

async function fetchReviewNodes(
  token: string,
  onProgress: (message: string) => void,
): Promise<{ viewer: string; teams: string[]; nodes: GitHubPull[]; warning: string | null }> {
  const { login, teams, warning } = await viewerContext(token)
  const seen = new Set<string>()
  const nodes: GitHubPull[] = []
  for (const query of reviewSearchQueries(teams)) {
    let cursor: string | null = null
    for (let page = 0; page < 6 && nodes.length < 120; page += 1) {
      onProgress(nodes.length === 0 ? 'Fetching pull requests to review' : `Fetching pull requests to review (${nodes.length} so far)`)
      const data: SearchData = await graphql<SearchData>(token, SEARCH_QUERY, { query, cursor })
      for (const node of data.search.nodes ?? []) {
        if (!node || seen.has(node.id) || node.author?.login === login) continue
        seen.add(node.id)
        nodes.push(node)
      }
      if (!data.search.pageInfo.hasNextPage) break
      cursor = data.search.pageInfo.endCursor
    }
  }
  return { viewer: login, teams, nodes, warning }
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

type RepoRules = { checks: string[]; requiredApprovals: number; dismissStale: boolean }

async function fetchRepoRules(token: string, repos: string[], onProgress: (message: string) => void) {
  const rules = new Map<string, RepoRules>()
  for (const repo of repos) {
    onProgress(`Reading required checks for ${repo}`)
    const rulesets = await readRulesets(token, repo)
    const policy = reviewPolicy(rulesets)
    rules.set(repo, { checks: requiredCheckNames(rulesets), ...policy })
  }
  return rules
}

async function readRulesets(token: string, repo: string): Promise<Parameters<typeof reviewPolicy>[0]> {
  const listResponse = await rest(token, `/repos/${repo}/rulesets?per_page=100`)
  if (!listResponse.ok) return []
  const list = (await listResponse.json()) as { id: number }[]
  const rulesets = await Promise.all(
    list.map(async (item) => {
      const response = await rest(token, `/repos/${repo}/rulesets/${item.id}`)
      return response.ok ? response.json() : null
    }),
  )
  return rulesets.filter((ruleset) => ruleset != null) as Parameters<typeof reviewPolicy>[0]
}

async function hydrate(
  token: string,
  viewer: string,
  teams: string[],
  nodes: GitHubPull[],
  onProgress: (message: string) => void,
  extraWarning: string | null,
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const repos = [...new Set(nodes.map((node) => node.repository.nameWithOwner))]
  const [bundles, required] = await Promise.all([
    fetchChecks(token, nodes.map((node) => node.id), onProgress),
    fetchRepoRules(token, repos, onProgress),
  ])
  const warnings: string[] = extraWarning ? [extraWarning] : []
  const pullRequests = nodes.map((node) => {
    const bundle = bundles.get(node.id)
    const rules = required.get(node.repository.nameWithOwner)
    if (!bundle) warnings.push(`${node.repository.nameWithOwner}#${node.number} is missing checks`)
    return mapPullRequest(node, {
      viewer,
      teams,
      requiredNames: rules?.checks ?? [],
      requiredApprovals: rules?.requiredApprovals ?? 0,
      dismissStale: rules?.dismissStale ?? false,
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

export async function fetchAuthoredPullRequests(
  token: string,
  onProgress: (message: string) => void,
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const { viewer, nodes } = await fetchNodes(token, onProgress)
  return hydrate(token, viewer, [], nodes, onProgress, null)
}

export async function fetchReviewPullRequests(
  token: string,
  onProgress: (message: string) => void,
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const { viewer, teams, nodes, warning } = await fetchReviewNodes(token, onProgress)
  return hydrate(token, viewer, teams, nodes, onProgress, warning)
}

export async function squashMergePullRequest(token: string, repo: string, number: number): Promise<void> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}/merge`, 'PUT', { merge_method: 'squash' })
  const text = await response.text()
  let payload: { message?: string; merged?: boolean } = {}
  if (text) {
    try {
      payload = JSON.parse(text) as { message?: string; merged?: boolean }
    } catch {
      payload = {}
    }
  }
  if (!response.ok || payload.merged === false) {
    throw new Error(payload.message || text.slice(0, 280) || `GitHub ${response.status}`)
  }
}

export async function rerunWorkflows(
  token: string,
  runs: { repo: string; runId: number }[],
  mode: 'failed' | 'all',
): Promise<{ reran: number; errors: string[]; runs: { repo: string; runId: number }[] }> {
  const seen = new Set<string>()
  let reran = 0
  const errors: string[] = []
  const restarted: { repo: string; runId: number }[] = []
  for (const run of runs) {
    const key = `${run.repo}#${run.runId}`
    if (seen.has(key)) continue
    seen.add(key)
    const suffix = mode === 'failed' ? 'rerun-failed-jobs' : 'rerun'
    const response = await rest(token, `/repos/${run.repo}/actions/runs/${run.runId}/${suffix}`, 'POST')
    if (response.ok) {
      reran += 1
      restarted.push(run)
      continue
    }
    const text = await response.text()
    errors.push(`${run.repo} run ${run.runId}: ${text.slice(0, 180) || response.status}`)
  }
  return { reran, errors, runs: restarted }
}

const LIVE_QUERY = `
  query Live($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number state isDraft mergeable mergeStateStatus reviewDecision
        baseRefName headRefName headRefOid
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              statusCheckRollup {
                contexts(first: 80) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl startedAt completedAt }
                    ... on StatusContext { context state targetUrl createdAt }
                  }
                }
              }
            }
          }
        }
        reviews(last: 40) { nodes { state submittedAt author { __typename login } } }
        reviewThreads(first: 60) {
          pageInfo { hasNextPage }
          nodes { isResolved }
        }
      }
    }
  }
`

type LiveData = {
  repository: {
    pullRequest: {
      number: number
      state: 'OPEN' | 'CLOSED' | 'MERGED'
      isDraft: boolean
      mergeable: string | null
      mergeStateStatus: string | null
      reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
      baseRefName: string
      headRefName: string
      headRefOid: string
      commits: {
        nodes: Array<{
          commit: {
            oid: string
            committedDate: string | null
            statusCheckRollup: { contexts: { nodes: Array<RawCheck | null> } } | null
          } | null
        } | null>
      }
      reviews: { nodes: Array<{ state: string; submittedAt: string | null; author: { __typename: string; login: string } | null } | null> | null }
      reviewThreads: {
        pageInfo: { hasNextPage: boolean }
        nodes: Array<{ isResolved: boolean } | null> | null
      }
    } | null
  } | null
}

export async function fetchLivePull(token: string, repo: string, number: number, requiredNames: string[]): Promise<LivePull> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Unknown repository ${repo}.`)
  const data = await graphql<LiveData>(token, LIVE_QUERY, { owner, name, number })
  const pull = data.repository?.pullRequest
  if (!pull) throw new Error(`Pull request ${repo}#${number} was not found.`)
  const commit = pull.commits.nodes?.[0]?.commit
  const nodes = (commit?.statusCheckRollup?.contexts.nodes ?? []).filter((node): node is RawCheck => node != null)
  const threads = (pull.reviewThreads.nodes ?? []).filter((thread): thread is { isResolved: boolean } => thread != null)
  const reviews = summarizeReviews((pull.reviews.nodes ?? []).filter((review): review is NonNullable<typeof review> => review != null))
  return {
    number: pull.number,
    state: pull.state,
    isDraft: pull.isDraft,
    mergeable: pull.mergeable === 'MERGEABLE' || pull.mergeable === 'CONFLICTING' || pull.mergeable === 'UNKNOWN' ? pull.mergeable : null,
    mergeStateStatus: pull.mergeStateStatus,
    reviewDecision: pull.reviewDecision,
    baseRef: pull.baseRefName,
    headRef: pull.headRefName,
    headOid: (commit?.oid ?? pull.headRefOid).toLowerCase(),
    unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
    threadsTruncated: pull.reviewThreads.pageInfo.hasNextPage,
    committedAt: commit?.committedDate ?? null,
    reviewers: reviews.reviewers,
    changesRequested: reviews.changesRequested,
    checks: checksFromRaw(nodes, requiredNames),
  }
}

export async function updatePullBase(token: string, repo: string, number: number, base: string): Promise<void> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}`, 'PATCH', { base })
  if (response.ok) return
  const text = await response.text()
  throw new Error(messageFrom(text, response.status))
}

export async function updatePullBranch(token: string, repo: string, number: number, expectedHeadSha: string): Promise<void> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}/update-branch`, 'PUT', {
    expected_head_sha: expectedHeadSha,
  })
  if (response.ok || response.status === 202) return
  const text = await response.text()
  throw new Error(messageFrom(text, response.status))
}

function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as { message?: string }
    if (payload.message) return payload.message
  } catch {
    // Use the raw body below.
  }
  return text.slice(0, 280) || `GitHub ${status}`
}
