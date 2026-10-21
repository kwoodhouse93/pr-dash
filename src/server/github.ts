import { execFileSync } from 'node:child_process'
import { summarizeReviews } from '../shared/approval.ts'
import { GRAPHQL_SINGLE_FLOOR, budgetFromHeaders, graphqlView, type GraphqlBudget, type GraphqlView } from '../shared/budget.ts'
import { checksFromRaw, mapPullRequest, type GitHubPull, type RawCheck, type ThreadDetail } from '../shared/map.ts'
import type { LivePull } from '../shared/queue.ts'
import { RULES_MAX_AGE_MS, requiredCheckNames, reviewPolicy } from '../shared/rules.ts'
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

export class GraphqlPaused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphqlPaused'
  }
}

let graphqlBudget: GraphqlBudget | null = null

export function graphqlStatus(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()): GraphqlView {
  return graphqlView(graphqlBudget, now, floor)
}

export function assertGraphql(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()) {
  const view = graphqlStatus(floor, now)
  if (view.paused && view.message) throw new GraphqlPaused(view.message)
}

function rememberGraphql(response: Response) {
  const next = budgetFromHeaders(response.headers)
  if (next) graphqlBudget = next
}

function markGraphqlSpent(resetAt = Date.now() + 60_000) {
  graphqlBudget = {
    limit: graphqlBudget?.limit ?? 5000,
    remaining: 0,
    resetAt: graphqlBudget && graphqlBudget.resetAt > Date.now() ? graphqlBudget.resetAt : resetAt,
  }
}

async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  assertGraphql()
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
  rememberGraphql(response)
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 280)}`)
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) {
    if (body.errors.some((error) => /rate limit/i.test(error.message))) {
      markGraphqlSpent()
      throw new GraphqlPaused(graphqlStatus().message ?? body.errors.map((error) => error.message).join('; '))
    }
    throw new Error(body.errors.map((error) => error.message).join('; '))
  }
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

function pullFields(threadComments: boolean): string {
  const comments = threadComments
    ? 'comments(last: 30) { nodes { author { __typename login } createdAt url } }'
    : ''
  return `
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
      ${comments}
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
}

const PULL_FIELDS = pullFields(false)

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

let viewerCache: { login: string; teams: string[]; at: number } | null = null

export function forgetViewerContext() {
  viewerCache = null
}

async function viewerContext(token: string): Promise<{ login: string; teams: string[]; warning: string | null }> {
  if (viewerCache && Date.now() - viewerCache.at < RULES_MAX_AGE_MS) {
    return { login: viewerCache.login, teams: viewerCache.teams, warning: null }
  }
  const viewer = await graphql<{ viewer: { login: string } }>(token, VIEWER_QUERY)
  const login = viewer.viewer.login
  try {
    const data = await graphql<TeamsData>(token, TEAMS_QUERY, { login })
    const teams = (data.viewer.organizations?.nodes ?? []).flatMap((org) =>
      (org?.teams.nodes ?? []).flatMap((team) => (team?.combinedSlug ? [team.combinedSlug] : [])),
    )
    viewerCache = { login, teams: [...new Set(teams)], at: Date.now() }
    return { login, teams: viewerCache.teams, warning: null }
  } catch {
    return { login, teams: viewerCache?.login === login ? viewerCache.teams : [], warning: 'Team review requests were not loaded.' }
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

export type RepoRules = { checks: string[]; requiredApprovals: number; dismissStale: boolean }

export type RulesLoader = (repos: string[]) => Promise<Map<string, RepoRules>>

export async function fetchRepoRules(token: string, repos: string[], onProgress: (message: string) => void) {
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
  loadRules: RulesLoader,
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const repos = [...new Set(nodes.map((node) => node.repository.nameWithOwner))]
  const [bundles, required] = await Promise.all([
    fetchChecks(token, nodes.map((node) => node.id), onProgress),
    loadRules(repos),
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
  loadRules: RulesLoader = (repos) => fetchRepoRules(token, repos, onProgress),
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const { viewer, nodes } = await fetchNodes(token, onProgress)
  return hydrate(token, viewer, [], nodes, onProgress, null, loadRules)
}

export async function fetchReviewPullRequests(
  token: string,
  onProgress: (message: string) => void,
  loadRules: RulesLoader = (repos) => fetchRepoRules(token, repos, onProgress),
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const { viewer, teams, nodes, warning } = await fetchReviewNodes(token, onProgress)
  return hydrate(token, viewer, teams, nodes, onProgress, warning, loadRules)
}

const CHECK_NODES = `
  __typename
  ... on CheckRun {
    name conclusion status detailsUrl startedAt completedAt
    isRequired(pullRequestId: $id)
    checkSuite { workflowRun { databaseId workflow { name } } }
  }
  ... on StatusContext { context state targetUrl createdAt }
`

const ONE_QUERY = `
  query One($id: ID!) {
    node(id: $id) {
      ... on PullRequest {
        state
        ${pullFields(true)}
        commits(last: 1) {
          nodes {
            commit {
              committedDate
              statusCheckRollup { contexts(first: 80) { nodes { ${CHECK_NODES} } } }
            }
          }
        }
      }
    }
  }
`

type OneCommit = {
  committedDate: string | null
  statusCheckRollup: { contexts: { nodes: Array<RawCheck | null> } } | null
} | null

type OneData = {
  node: (GitHubPull & {
    state?: 'OPEN' | 'CLOSED' | 'MERGED'
    commits?: { nodes: Array<{ commit: OneCommit } | null> }
  }) | null
}

export async function fetchOnePull(
  token: string,
  id: string,
): Promise<{ pull: GitHubPull; open: boolean; committedAt: string | null; checks: RawCheck[] } | null> {
  const data = await graphql<OneData>(token, ONE_QUERY, { id })
  const node = data.node
  if (!node) return null
  const commit = node.commits?.nodes?.[0]?.commit
  const checks = (commit?.statusCheckRollup?.contexts.nodes ?? []).filter((item): item is RawCheck => item != null)
  return { pull: node, open: node.state == null || node.state === 'OPEN', committedAt: commit?.committedDate ?? null, checks }
}

const THREAD_QUERY = `
  query Threads($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        updatedAt
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
        latestComments: comments(last: 20) { nodes { author { __typename login } createdAt body } }
      }
    }
  }
`

type ThreadNode = ThreadDetail & { id?: string }

export async function fetchThreadDetails(token: string, ids: string[]): Promise<Map<string, ThreadDetail>> {
  const found = new Map<string, ThreadDetail>()
  for (let index = 0; index < ids.length; index += 4) {
    const batch = ids.slice(index, index + 4)
    const data = await graphql<{ nodes: Array<ThreadNode | null> | null }>(token, THREAD_QUERY, { ids: batch })
    for (const node of data.nodes ?? []) {
      if (!node?.id) continue
      found.set(node.id, node)
    }
  }
  return found
}

export async function viewerFor(token: string): Promise<{ login: string; teams: string[] }> {
  const viewer = await viewerContext(token)
  return { login: viewer.login, teams: viewer.teams }
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
