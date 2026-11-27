import { execFileSync } from 'node:child_process'
import {
  asNote,
  asThread,
  feedbackCounts,
  quoteReply,
  threadPermalink,
  type FeedbackAuthor,
  type FeedbackDetail,
  type FeedbackNote,
  type FeedbackPayload,
  type LocalResolutions,
} from '../shared/feedback.ts'
import { summarizeReviews } from '../shared/approval.ts'
import { GRAPHQL_SINGLE_FLOOR, budgetFromHeaders, graphqlView, rememberWindow, type GraphqlBudget, type GraphqlView } from '../shared/budget.ts'
import {
  needsFreshBehind,
  planCheckReads,
  readsAfterProbe,
  reuseChecks,
} from '../shared/freshness.ts'
import { checksFromRaw, mapPullRequest, shadowedRuns, type GitHubPull, type RawCheck, type RawCheckSuite, type ThreadDetail } from '../shared/map.ts'
import type { LivePull, RemotePullState } from '../shared/queue.ts'
import { authoredSearchQueries, reviewSearchQueries } from '../shared/repos.ts'
import { RULES_MAX_AGE_MS, requiredCheckNames, reviewPolicy, type Ruleset } from '../shared/rules.ts'
import type { CheckCursor, CheckRollup, PullRequest } from '../shared/types.ts'
import { requestSignal } from './request-signal.ts'

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

let graphqlWindows: GraphqlBudget[] = []

export function graphqlStatus(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()): GraphqlView {
  return graphqlView(graphqlWindows, now, floor)
}

export function assertGraphql(floor = GRAPHQL_SINGLE_FLOOR, now = Date.now()) {
  const view = graphqlStatus(floor, now)
  if (view.paused && view.message) throw new GraphqlPaused(view.message)
}

function rememberGraphql(response: Response): GraphqlBudget | null {
  const next = budgetFromHeaders(response.headers)
  if (!next) return null
  graphqlWindows = rememberWindow(graphqlWindows, next)
  return graphqlWindows.find((window) => window.resetAt === next.resetAt) ?? next
}

function markGraphqlSpent(seen: GraphqlBudget | null, resetAt = Date.now() + 60_000) {
  const when = seen && seen.resetAt > Date.now() ? seen.resetAt : resetAt
  graphqlWindows = rememberWindow(graphqlWindows, { limit: seen?.limit ?? 5000, remaining: 0, resetAt: when })
}

async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>, partial = false): Promise<T> {
  assertGraphql()
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pr-dash',
    },
    body: JSON.stringify({ query, variables }),
    signal: requestSignal(60_000),
  })
  const seen = rememberGraphql(response)
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 280)}`)
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) {
    if (body.errors.some((error) => /rate limit/i.test(error.message))) {
      markGraphqlSpent(seen)
      throw new GraphqlPaused(graphqlStatus().message ?? body.errors.map((error) => error.message).join('; '))
    }
    if (!partial || !body.data) throw new Error(body.errors.map((error) => error.message).join('; '))
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
    signal: requestSignal(60_000),
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
  reviews(last: 40) { nodes { id state submittedAt body author { __typename login avatarUrl } } }
  readyEvents: timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }
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
  latestComments: comments(last: 20) { nodes { id author { __typename login } createdAt body } }
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

/** GitHub Actions. Suites from this app are the workflow runs that the check rollup can omit. */
const GITHUB_ACTIONS_APP_ID = 15368

const ACTION_SUITES = `
  checkSuites(first: 40, filterBy: { appId: ${GITHUB_ACTIONS_APP_ID} }) {
    nodes {
      status
      conclusion
      createdAt
      updatedAt
      url
      workflowRun { databaseId url workflow { name } }
      checkRuns(first: 1) { totalCount }
    }
  }
`

type CommitChecks = {
  oid?: string | null
  committedDate?: string | null
  statusCheckRollup?: {
    state?: string | null
    contexts: { totalCount?: number; nodes?: Array<RawCheck | null> }
  } | null
  checkSuites?: { nodes: Array<RawCheckSuite | null> | null } | null
}

function readCommitChecks(commit: CommitChecks | null | undefined): {
  committedAt: string | null
  checks: RawCheck[]
  suites: RawCheckSuite[]
  rollup: CheckRollup | null
} {
  return {
    committedAt: commit?.committedDate ?? null,
    checks: (commit?.statusCheckRollup?.contexts.nodes ?? []).filter((node): node is RawCheck => node != null),
    suites: (commit?.checkSuites?.nodes ?? []).filter((suite): suite is RawCheckSuite => suite != null),
    rollup: rollupOf(commit),
  }
}

function rollupOf(commit: CommitChecks | null | undefined): CheckRollup | null {
  const oid = commit?.oid
  if (!oid) return null
  const rollup = commit.statusCheckRollup
  if (!rollup) return { oid, rollup: null, count: 0 }
  if (rollup.state === undefined && rollup.contexts?.totalCount === undefined) return null
  return {
    oid,
    rollup: rollup.state ?? null,
    count: rollup.contexts?.totalCount ?? 0,
  }
}

function stampCursor(rollup: CheckRollup | null, readAt = new Date().toISOString()): CheckCursor | null {
  if (!rollup) return null
  return { ...rollup, readAt }
}

async function eachBatch<T>(items: T[], size: number, concurrency: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size))
  let next = 0
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next]
      next += 1
      if (!batch) return
      await run(batch)
    }
  }
  const workers = Math.min(Math.max(concurrency, 1), batches.length)
  if (workers === 0) return
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

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

const LIST_CAP = 240

function keptRepos(nodes: GitHubPull[], repos: string[]): GitHubPull[] {
  const allowed = new Set(repos)
  return nodes.filter((node) => allowed.has(node.repository.nameWithOwner))
}

async function fetchSearchNodes(
  token: string,
  queries: string[],
  onProgress: (message: string) => void,
  label: string,
): Promise<GitHubPull[]> {
  const seen = new Set<string>()
  const nodes: GitHubPull[] = []
  for (const query of queries) {
    let cursor: string | null = null
    for (let page = 0; page < 6 && nodes.length < LIST_CAP; page += 1) {
      onProgress(nodes.length === 0 ? label : `${label} (${nodes.length} so far)`)
      const data: SearchData = await graphql<SearchData>(token, SEARCH_QUERY, { query, cursor })
      for (const node of data.search.nodes ?? []) {
        if (!node || seen.has(node.id)) continue
        seen.add(node.id)
        nodes.push(node)
      }
      if (!data.search.pageInfo.hasNextPage) break
      cursor = data.search.pageInfo.endCursor
    }
  }
  return nodes
}

async function loginFor(token: string): Promise<string> {
  if (viewerCache && Date.now() - viewerCache.at < RULES_MAX_AGE_MS) return viewerCache.login
  const viewer = await graphql<{ viewer: { login: string } }>(token, VIEWER_QUERY)
  return viewer.viewer.login
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
  repos: string[],
  onProgress: (message: string) => void,
): Promise<{ viewer: string; teams: string[]; nodes: GitHubPull[]; warning: string | null }> {
  const { login, teams, warning } = await viewerContext(token)
  const nodes = await fetchSearchNodes(token, reviewSearchQueries(teams, repos), onProgress, 'Fetching pull requests to review')
  const others = nodes.filter((node) => node.author?.login !== login)
  return { viewer: login, teams, nodes: keptRepos(others, repos), warning }
}

type CheckData = Record<string, {
  id?: string
  commits?: { nodes: Array<{ commit: CommitChecks | null } | null> }
} | null>

type CheckBundle = {
  committedAt: string | null
  checks: RawCheck[]
  suites: RawCheckSuite[]
  cursor: CheckCursor | null
}

async function fetchChecks(
  token: string,
  ids: string[],
  onProgress: (message: string) => void,
  unchanged = 0,
) {
  const bundles = new Map<string, CheckBundle>()
  if (ids.length === 0) return bundles
  let done = 0
  const kept = unchanged > 0 ? `, ${unchanged} unchanged` : ''
  const note = () => onProgress(`Fetching checks ${Math.min(done, ids.length)} of ${ids.length}${kept}`)
  note()
  await eachBatch(ids, 4, 2, async (batch) => {
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
                  oid
                  committedDate
                  statusCheckRollup {
                    state
                    contexts(first: 80) {
                      totalCount
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
                  ${ACTION_SUITES}
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
    const readAt = new Date().toISOString()
    batch.forEach((id, number) => {
      const loaded = readCommitChecks(data[`p${number}`]?.commits?.nodes?.[0]?.commit)
      bundles.set(id, {
        committedAt: loaded.committedAt,
        checks: loaded.checks,
        suites: loaded.suites,
        cursor: stampCursor(loaded.rollup, readAt),
      })
    })
    done += batch.length
    note()
  })
  return bundles
}

type CursorData = Record<string, {
  id?: string
  commits?: { nodes: Array<{ commit: CommitChecks | null } | null> }
} | null>

/** Head oid and combined rollup, without the individual checks. One miss does not fail the rest. */
async function fetchCheckCursors(token: string, ids: string[]): Promise<Map<string, CheckRollup | null>> {
  const found = new Map<string, CheckRollup | null>()
  await eachBatch(ids, 12, 3, async (batch) => {
    const varDefs = batch.map((_, number) => `$id${number}: ID!`).join(', ')
    const fields = batch
      .map(
        (_, number) => `
        p${number}: node(id: $id${number}) {
          ... on PullRequest {
            id
            commits(last: 1) {
              nodes { commit { oid statusCheckRollup { state contexts { totalCount } } } }
            }
          }
        }
      `,
      )
      .join('\n')
    const variables = Object.fromEntries(batch.map((id, number) => [`id${number}`, id]))
    const data = await graphql<CursorData>(token, `query Cursors(${varDefs}) { ${fields} }`, variables, true)
    batch.forEach((id, number) => {
      const node = data[`p${number}`]
      found.set(id, node?.id ? rollupOf(node.commits?.nodes?.[0]?.commit) : null)
    })
  })
  return found
}

type BehindNode = {
  id?: string
  baseRef?: { compare?: { behindBy?: number | null } | null } | null
} | null

/**
 * Commits on the base that the head is missing. A missing comparison is omitted so callers
 * can fall back to mergeStateStatus. One unresolved ref does not fail the rest of the batch.
 */
async function fetchBehind(token: string, pulls: { id: string; number: number }[]): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  await eachBatch(pulls, 8, 3, async (batch) => {
    const varDefs = batch.map((_, number) => `$id${number}: ID!, $head${number}: String!`).join(', ')
    const fields = batch
      .map(
        (_, number) => `
        p${number}: node(id: $id${number}) {
          ... on PullRequest {
            id
            baseRef { compare(headRef: $head${number}) { behindBy } }
          }
        }
      `,
      )
      .join('\n')
    const variables: Record<string, string> = {}
    batch.forEach((pull, number) => {
      variables[`id${number}`] = pull.id
      variables[`head${number}`] = `refs/pull/${pull.number}/head`
    })
    const data = await graphql<Record<string, BehindNode>>(token, `query Behind(${varDefs}) { ${fields} }`, variables, true)
    batch.forEach((_, number) => {
      const node = data[`p${number}`]
      const behindBy = node?.baseRef?.compare?.behindBy
      if (node?.id && typeof behindBy === 'number') found.set(node.id, behindBy)
    })
  })
  return found
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

/** The rulesets that apply to the repository's default branch. Every ruleset, when GitHub will not say which apply. */
export async function readRulesets(token: string, repo: string): Promise<Ruleset[]> {
  const [listResponse, applying] = await Promise.all([rest(token, `/repos/${repo}/rulesets?per_page=100`), trunkRulesetIds(token, repo)])
  if (!listResponse.ok) return []
  const list = (await listResponse.json()) as { id: number }[]
  const rulesets = await Promise.all(
    list
      .filter((item) => applying == null || applying.has(item.id))
      .map(async (item) => {
        const response = await rest(token, `/repos/${repo}/rulesets/${item.id}`)
        return response.ok ? response.json() : null
      }),
  )
  return rulesets.filter((ruleset) => ruleset != null) as Ruleset[]
}

async function trunkRulesetIds(token: string, repo: string): Promise<Set<number> | null> {
  const repoResponse = await rest(token, `/repos/${repo}`)
  if (!repoResponse.ok) return null
  const trunk = ((await repoResponse.json()) as { default_branch?: string }).default_branch
  if (!trunk) return null
  const response = await rest(token, `/repos/${repo}/rules/branches/${encodeURIComponent(trunk)}?per_page=100`)
  if (!response.ok) return null
  const rules = (await response.json()) as { ruleset_id?: number }[]
  // A full page may not be every rule, and a ruleset left out would drop its required checks.
  if (rules.length >= 100) return null
  return new Set(rules.flatMap((rule) => (typeof rule.ruleset_id === 'number' ? [rule.ruleset_id] : [])))
}

function keptBehind(previous: PullRequest): number {
  return previous.behind ? 1 : 0
}

async function loadCheckBundles(
  token: string,
  nodes: GitHubPull[],
  previous: Map<string, PullRequest>,
  forceChecks: boolean,
  onProgress: (message: string) => void,
): Promise<{ bundles: Map<string, CheckBundle>; reuseIds: string[] }> {
  const plan = planCheckReads(
    nodes.map((node) => ({ id: node.id, updatedAt: node.updatedAt })),
    previous,
    forceChecks,
  )
  let fetchIds = plan.fetch
  let reuseIds: string[] = []
  if (plan.probe.length > 0) {
    onProgress(`Comparing checks for ${plan.probe.length} pull requests`)
    try {
      const seen = await fetchCheckCursors(token, plan.probe)
      const decided = readsAfterProbe(plan.probe, previous, seen, Date.now())
      fetchIds = [...plan.fetch, ...decided.fetch]
      reuseIds = decided.reuse
    } catch (error) {
      if (error instanceof GraphqlPaused) throw error
      if (error instanceof Error && error.name === 'AbortError') throw error
      fetchIds = nodes.map((node) => node.id)
      reuseIds = []
    }
  }
  if (fetchIds.length === 0 && nodes.length > 0) onProgress(`Checks unchanged for ${reuseIds.length} pull requests`)
  const bundles = await fetchChecks(token, fetchIds, onProgress, reuseIds.length)
  return { bundles, reuseIds }
}

async function hydrate(
  token: string,
  viewer: string,
  teams: string[],
  nodes: GitHubPull[],
  onProgress: (message: string) => void,
  extraWarning: string | null,
  loadRules: RulesLoader,
  previous: PullRequest[] = [],
  forceChecks = false,
  local: LocalResolutions = {},
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  const previousById = new Map(previous.map((pr) => [pr.id, pr]))
  const repos = [...new Set(nodes.map((node) => node.repository.nameWithOwner))]
  const behindPulls = nodes.filter((node) =>
    needsFreshBehind(previousById.get(node.id), {
      updatedAt: node.updatedAt,
      mergeStateStatus: node.mergeStateStatus,
      mergeable: node.mergeable,
    }),
  )
  const [loaded, behind, required] = await Promise.all([
    loadCheckBundles(token, nodes, previousById, forceChecks, onProgress),
    fetchBehind(
      token,
      behindPulls.map((node) => ({ id: node.id, number: node.number })),
    ),
    loadRules(repos),
  ])
  const reuseIds = new Set(loaded.reuseIds)
  const warnings: string[] = extraWarning ? [extraWarning] : []
  const pullRequests = nodes.map((node) => {
    const bundle = loaded.bundles.get(node.id)
    const prior = previousById.get(node.id)
    const rules = required.get(node.repository.nameWithOwner)
    const behindBy = behind.has(node.id) ? (behind.get(node.id) ?? null) : prior && !needsFreshBehind(prior, node) ? keptBehind(prior) : null
    if (!bundle && !reuseIds.has(node.id)) warnings.push(`${node.repository.nameWithOwner}#${node.number} is missing checks`)
    const mapped = mapPullRequest(node, {
      viewer,
      teams,
      requiredNames: rules?.checks ?? [],
      requiredApprovals: rules?.requiredApprovals ?? 0,
      dismissStale: rules?.dismissStale ?? false,
      committedAt: bundle?.committedAt ?? prior?.committedAt ?? null,
      checks: bundle?.checks ?? [],
      suites: bundle?.suites ?? [],
      behindBy,
      local,
    })
    if (bundle) return { ...mapped, checkCursor: bundle.cursor }
    if (prior && reuseIds.has(node.id)) {
      const kept = reuseChecks(prior, rules?.checks ?? prior.requiredCheckNames)
      return { ...mapped, ...kept }
    }
    return mapped
  })
  return {
    viewer,
    pullRequests,
    warning: warnings.length ? warnings.slice(0, 3).join('; ') : null,
  }
}

export type ListHydration = {
  previous?: PullRequest[]
  /** Read every check list again. A full sync uses this so required checks are rebuilt from the rules. */
  forceChecks?: boolean
  /** What the viewer resolved on this dashboard only. */
  local?: LocalResolutions
}

export async function fetchAuthoredPullRequests(
  token: string,
  onProgress: (message: string) => void,
  repos: string[],
  loadRules: RulesLoader = (needed) => fetchRepoRules(token, needed, onProgress),
  hydration: ListHydration = {},
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  if (repos.length === 0) return { viewer: '', pullRequests: [], warning: null }
  const viewer = await loginFor(token)
  const nodes = keptRepos(await fetchSearchNodes(token, authoredSearchQueries(repos), onProgress, 'Fetching your pull requests'), repos)
  return hydrate(token, viewer, [], nodes, onProgress, null, loadRules, hydration.previous ?? [], hydration.forceChecks === true, hydration.local)
}

export async function fetchReviewPullRequests(
  token: string,
  onProgress: (message: string) => void,
  repos: string[],
  loadRules: RulesLoader = (needed) => fetchRepoRules(token, needed, onProgress),
  hydration: ListHydration = {},
): Promise<{ viewer: string; pullRequests: PullRequest[]; warning: string | null }> {
  if (repos.length === 0) return { viewer: '', pullRequests: [], warning: null }
  const { viewer, teams, nodes, warning } = await fetchReviewNodes(token, repos, onProgress)
  return hydrate(token, viewer, teams, nodes, onProgress, warning, loadRules, hydration.previous ?? [], hydration.forceChecks === true, hydration.local)
}

let accessibleCache: { at: number; names: string[]; truncated: boolean } | null = null
const ACCESSIBLE_REPOS_MS = 5 * 60 * 1000

export async function listAccessibleRepos(token: string): Promise<{ names: string[]; truncated: boolean }> {
  if (accessibleCache && Date.now() - accessibleCache.at < ACCESSIBLE_REPOS_MS) {
    return { names: accessibleCache.names, truncated: accessibleCache.truncated }
  }
  const names: string[] = []
  let truncated = false
  for (let page = 1; page <= 10; page += 1) {
    const response = await rest(
      token,
      `/user/repos?per_page=100&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`,
    )
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GitHub ${response.status}: ${text.slice(0, 180)}`)
    }
    const body = (await response.json()) as { full_name?: string; archived?: boolean }[]
    if (!Array.isArray(body) || body.length === 0) break
    for (const repo of body) {
      if (repo.full_name && !repo.archived) names.push(repo.full_name)
    }
    if (body.length === 100 && page === 10) truncated = true
    if (body.length < 100) break
  }
  names.sort((left, right) => left.localeCompare(right))
  accessibleCache = { at: Date.now(), names, truncated }
  return { names, truncated }
}

export async function repositoryVisible(token: string, repo: string): Promise<boolean> {
  const response = await rest(token, `/repos/${repo}`)
  if (response.ok) return true
  if (response.status === 404) return false
  const text = await response.text()
  throw new Error(`GitHub ${response.status}: ${text.slice(0, 180)}`)
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
              oid
              committedDate
              statusCheckRollup {
                state
                contexts(first: 80) { totalCount nodes { ${CHECK_NODES} } }
              }
              ${ACTION_SUITES}
            }
          }
        }
      }
    }
  }
`

type OneCommit = CommitChecks | null

type OneData = {
  node: (GitHubPull & {
    state?: 'OPEN' | 'CLOSED' | 'MERGED'
    commits?: { nodes: Array<{ commit: OneCommit } | null> }
  }) | null
}

export async function fetchOnePull(
  token: string,
  id: string,
): Promise<{
  pull: GitHubPull
  open: boolean
  committedAt: string | null
  checks: RawCheck[]
  suites: RawCheckSuite[]
  behindBy: number | null
  cursor: CheckCursor | null
} | null> {
  const data = await graphql<OneData>(token, ONE_QUERY, { id })
  const node = data.node
  if (!node) return null
  const commit = readCommitChecks(node.commits?.nodes?.[0]?.commit)
  const behind = await fetchBehind(token, [{ id: node.id, number: node.number }])
  return {
    pull: node,
    open: node.state == null || node.state === 'OPEN',
    committedAt: commit.committedAt,
    checks: commit.checks,
    suites: commit.suites,
    behindBy: behind.get(node.id) ?? null,
    cursor: stampCursor(commit.rollup),
  }
}

const THREAD_QUERY = `
  query Threads($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        updatedAt
        reviews(last: 40) { nodes { id state submittedAt body author { __typename login } } }
        reviewThreads(first: 60) {
          pageInfo { hasNextPage }
          nodes {
            isResolved
            isOutdated
            resolvedBy { login }
            comments(last: 30) { nodes { author { __typename login } createdAt url } }
          }
        }
        latestComments: comments(last: 20) { nodes { id author { __typename login } createdAt body } }
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

/**
 * Squash merges the pull request if its head is still `headSha`, the commit whose checks and reviews
 * were just read. `moved` means the branch has a different head, and nothing was merged.
 */
export async function squashMergePullRequest(token: string, repo: string, number: number, headSha: string): Promise<'merged' | 'moved'> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}/merge`, 'PUT', { merge_method: 'squash', sha: headSha })
  const text = await response.text()
  if (response.status === 409 && /head branch was modified/i.test(text)) return 'moved'
  if (!response.ok || /"merged"\s*:\s*false/.test(text)) throw new Error(messageFrom(text, response.status))
  return 'merged'
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

const PULL_STATE_QUERY = `
  query PullState($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { state }
    }
  }
`

export async function fetchPullState(token: string, repo: string, number: number): Promise<RemotePullState> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) return 'unknown'
  const data = await graphql<{ repository: { pullRequest: { state: 'OPEN' | 'CLOSED' | 'MERGED' } | null } | null }>(
    token,
    PULL_STATE_QUERY,
    { owner, name, number },
  )
  const state = data.repository?.pullRequest?.state
  if (state === 'OPEN' || state === 'CLOSED' || state === 'MERGED') return state
  return 'unknown'
}

export type PullOutcome = { state: 'OPEN' | 'CLOSED' | 'MERGED'; at: string | null }

/** What became of each pull request, in one request for every 40. One GitHub cannot find is left out. */
export async function fetchPullOutcomes(token: string, refs: { key: string; repo: string; number: number }[]): Promise<Map<string, PullOutcome>> {
  const found = new Map<string, PullOutcome>()
  const valid = refs.filter((ref) => /^[\w.-]+\/[\w.-]+$/.test(ref.repo) && Number.isInteger(ref.number))
  for (let start = 0; start < valid.length; start += 40) {
    const chunk = valid.slice(start, start + 40)
    const fields = chunk.map((ref, index) => {
      const [owner, name] = ref.repo.split('/')
      return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${ref.number}) { state mergedAt closedAt } }`
    })
    type Row = { pullRequest: { state: PullOutcome['state']; mergedAt: string | null; closedAt: string | null } | null } | null
    const data = await graphql<Record<string, Row>>(token, `query PullOutcomes { ${fields.join(' ')} }`, undefined, true)
    for (const [index, ref] of chunk.entries()) {
      const pull = data[`p${index}`]?.pullRequest
      if (pull) found.set(ref.key, { state: pull.state, at: pull.state === 'MERGED' ? pull.mergedAt : pull.closedAt })
    }
  }
  return found
}

const LIVE_QUERY = `
  query Live($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id number state isDraft mergeable mergeStateStatus reviewDecision
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
                    ... on CheckRun {
                      name conclusion status detailsUrl startedAt completedAt
                      checkSuite { workflowRun { databaseId workflow { name } } }
                    }
                    ... on StatusContext { context state targetUrl createdAt }
                  }
                }
              }
              ${ACTION_SUITES}
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
      id: string
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
            checkSuites?: { nodes: Array<RawCheckSuite | null> | null } | null
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
  const loaded = readCommitChecks(commit)
  const threads = (pull.reviewThreads.nodes ?? []).filter((thread): thread is { isResolved: boolean } => thread != null)
  const reviews = summarizeReviews((pull.reviews.nodes ?? []).filter((review): review is NonNullable<typeof review> => review != null))
  const behind = await fetchBehind(token, [{ id: pull.id, number: pull.number }])
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
    behindBy: behind.get(pull.id) ?? null,
    unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
    threadsTruncated: pull.reviewThreads.pageInfo.hasNextPage,
    committedAt: loaded.committedAt,
    reviewers: reviews.reviewers,
    changesRequested: reviews.changesRequested,
    checks: checksFromRaw(loaded.checks, requiredNames, { suites: loaded.suites, mergeStateStatus: pull.mergeStateStatus }),
    shadowed: shadowedRuns(loaded.checks, requiredNames),
  }
}

export async function updatePullBase(token: string, repo: string, number: number, base: string): Promise<void> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}`, 'PATCH', { base })
  if (response.ok) return
  const text = await response.text()
  throw new Error(messageFrom(text, response.status))
}

/** Whether `head` has `ancestor` in its history. */
export async function commitContains(token: string, repo: string, ancestor: string, head: string): Promise<boolean> {
  const response = await rest(token, `/repos/${repo}/compare/${ancestor}...${head}?per_page=1`)
  const text = await response.text()
  if (!response.ok) throw new Error(messageFrom(text, response.status))
  const status = (JSON.parse(text) as { status?: string }).status
  return status === 'ahead' || status === 'identical'
}

const MARK_READY = `
  mutation MarkReady($id: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }
`

/**
 * REST `PATCH` with `draft: false` returns success and leaves the pull request a draft.
 * GitHub only clears draft status through this mutation.
 */
export async function markPullReadyForReview(token: string, pullRequestId: string): Promise<void> {
  const data = await graphql<{
    markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } | null } | null
  }>(token, MARK_READY, { id: pullRequestId })
  if (data.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
    throw new Error('GitHub left that pull request as a draft.')
  }
}

/**
 * Merges the base into the pull request's branch. `moved` means the branch head is no longer
 * `expectedHeadSha`, as when GitHub reported a head that a push had just replaced.
 */
export async function updatePullBranch(
  token: string,
  repo: string,
  number: number,
  expectedHeadSha: string,
): Promise<'updated' | 'moved'> {
  const response = await rest(token, `/repos/${repo}/pulls/${number}/update-branch`, 'PUT', {
    expected_head_sha: expectedHeadSha,
  })
  if (response.ok || response.status === 202) return 'updated'
  const text = await response.text()
  if (response.status === 422 && /expected head sha/i.test(text)) return 'moved'
  throw new Error(messageFrom(text, response.status))
}

const FEEDBACK_QUERY = `
  query Feedback($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id title url number
        reviewThreads(first: 60) {
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            startLine
            originalStartLine
            resolvedBy { login }
            comments(last: 30) {
              pageInfo { hasPreviousPage }
              nodes {
                id
                body
                createdAt
                url
                diffHunk
                author { __typename login avatarUrl }
              }
            }
          }
        }
        comments(last: 20) {
          nodes { id body createdAt url author { __typename login avatarUrl } }
        }
        reviews(last: 40) {
          nodes { id state submittedAt body url author { __typename login avatarUrl } }
        }
      }
    }
  }
`

const REPLY_THREAD = `
  mutation ReplyThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id }
    }
  }
`

const RESOLVE_THREAD = `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const UNRESOLVE_THREAD = `
  mutation UnresolveThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const ADD_COMMENT = `
  mutation AddComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
  }
`

type RawActor = { __typename: string; login: string; avatarUrl?: string | null } | null

type RawFeedbackComment = {
  id: string
  body: string
  createdAt: string
  url: string | null
  diffHunk?: string | null
  author: RawActor
}

type RawFeedback = {
  repository: {
    pullRequest: {
      id: string
      title: string
      url: string
      number: number
      reviewThreads: {
        pageInfo: { hasNextPage: boolean }
        nodes: Array<{
          id: string
          isResolved: boolean
          isOutdated: boolean
          path: string | null
          line: number | null
          originalLine: number | null
          startLine: number | null
          originalStartLine: number | null
          resolvedBy: { login: string } | null
          comments: {
            pageInfo: { hasPreviousPage: boolean }
            nodes: Array<RawFeedbackComment | null> | null
          }
        } | null> | null
      }
      comments: { nodes: Array<{ id: string; body: string; createdAt: string; url: string | null; author: RawActor } | null> | null }
      reviews: {
        nodes: Array<{
          id: string
          state: string
          submittedAt: string | null
          body: string | null
          url: string | null
          author: RawActor
        } | null> | null
      }
    } | null
  } | null
}

const SKIPPED_REVIEW = new Set(['PENDING', 'DISMISSED'])

function feedbackAuthor(author: RawActor): FeedbackAuthor | null {
  if (!author?.login) return null
  return { __typename: author.__typename, login: author.login, avatarUrl: author.avatarUrl ?? null }
}

function mapFeedback(data: RawFeedback): FeedbackDetail {
  const pull = data.repository?.pullRequest
  if (!pull) throw new Error('That pull request was not found.')
  const threads = (pull.reviewThreads.nodes ?? []).filter((thread): thread is NonNullable<typeof thread> => thread != null).map((thread) => {
    const comments = (thread.comments.nodes ?? []).filter((comment): comment is RawFeedbackComment => comment != null).map((comment) => ({
      id: comment.id,
      author: feedbackAuthor(comment.author),
      createdAt: comment.createdAt,
      body: comment.body ?? '',
      url: comment.url,
      diffHunk: comment.diffHunk ?? null,
    }))
    const hunk = comments.find((comment) => comment.diffHunk)?.diffHunk ?? null
    return {
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      resolvedBy: thread.resolvedBy?.login ?? null,
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      startLine: thread.startLine ?? thread.originalStartLine,
      url: threadPermalink(comments),
      diffHunk: hunk,
      commentsTruncated: thread.comments.pageInfo.hasPreviousPage,
      comments,
    }
  })
  const commentNotes: FeedbackNote[] = (pull.comments.nodes ?? []).flatMap((comment) => {
    if (!comment) return []
    const author = feedbackAuthor(comment.author)
    if (author?.__typename !== 'User' || !comment.body.trim()) return []
    return [{ id: comment.id, author, createdAt: comment.createdAt, body: comment.body, url: comment.url, kind: 'comment' as const }]
  })
  const reviewNotes: FeedbackNote[] = (pull.reviews.nodes ?? []).flatMap((review) => {
    if (!review || SKIPPED_REVIEW.has(review.state) || !review.body?.trim()) return []
    const author = feedbackAuthor(review.author)
    if (author?.__typename !== 'User') return []
    return [{
      id: review.id,
      author,
      createdAt: review.submittedAt ?? '',
      body: review.body ?? '',
      url: review.url,
      kind: 'review' as const,
    }]
  })
  return {
    pullId: pull.id,
    title: pull.title,
    url: pull.url,
    number: pull.number,
    threadsTruncated: pull.reviewThreads.pageInfo.hasNextPage,
    threads,
    notes: [...commentNotes, ...reviewNotes],
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Unknown repository ${repo}.`)
  return { owner, name }
}

export async function fetchPullFeedback(token: string, repo: string, number: number): Promise<FeedbackDetail> {
  const { owner, name } = splitRepo(repo)
  const data = await graphql<RawFeedback>(token, FEEDBACK_QUERY, { owner, name, number })
  return mapFeedback(data)
}

function requireReply(body: string): string {
  const text = body.trim()
  if (!text) {
    const error = new Error('Write a reply first.')
    error.name = 'FeedbackRejected'
    throw error
  }
  return text
}

export async function replyToReviewThread(token: string, repo: string, number: number, threadId: string, body: string): Promise<FeedbackDetail> {
  const text = requireReply(body)
  await graphql(token, REPLY_THREAD, { threadId, body: text })
  return fetchPullFeedback(token, repo, number)
}

export async function setReviewThreadResolved(
  token: string,
  repo: string,
  number: number,
  threadId: string,
  resolved: boolean,
): Promise<FeedbackDetail> {
  await graphql(token, resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId })
  return fetchPullFeedback(token, repo, number)
}

export async function replyToPullNote(token: string, repo: string, number: number, noteId: string, body: string): Promise<FeedbackDetail> {
  const text = requireReply(body)
  const current = await fetchPullFeedback(token, repo, number)
  const note = current.notes.find((item) => item.id === noteId)
  if (!note) {
    const error = new Error('That comment is no longer on the pull request.')
    error.name = 'FeedbackRejected'
    throw error
  }
  const quoted = quoteReply({ authorLogin: note.author?.login ?? null, body: note.body, url: note.url }, text)
  await graphql(token, ADD_COMMENT, { subjectId: current.pullId, body: quoted })
  return fetchPullFeedback(token, repo, number)
}

export function payloadFor(detail: FeedbackDetail, viewerLogin: string, local: LocalResolutions = {}): FeedbackPayload {
  const ids = detail.notes.map((note) => note.id)
  return {
    detail,
    counts: feedbackCounts(detail.threads.map(asThread), detail.notes.map(asNote), viewerLogin, detail.threadsTruncated, local),
    local: Object.fromEntries(ids.flatMap((id) => (Object.hasOwn(local, id) ? [[id, local[id]!]] : []))),
  }
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
