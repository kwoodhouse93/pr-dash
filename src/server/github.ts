import type { LocalResolutions } from '../shared/feedback.ts'
import { needsFreshBehind, planCheckReads, readsAfterProbe, reuseChecks } from '../shared/freshness.ts'
import { type GitHubPull, mapPullRequest, type RawCheck, type RawCheckSuite, type ThreadDetail } from '../shared/map.ts'
import { authoredSearchQueries, reviewSearchQueries } from '../shared/repos.ts'
import { requiredCheckNames, reviewPolicy, RULES_MAX_AGE_MS, type Ruleset } from '../shared/rules.ts'
import type { CheckCursor, CheckRollup, PullRequest } from '../shared/types.ts'
import { eachBatch, graphql, GraphqlPaused, rest } from './github-client.ts'

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

export const ACTION_SUITES = `
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

export function readCommitChecks(commit: CommitChecks | null | undefined): {
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
export async function fetchBehind(token: string, pulls: { id: string; number: number }[]): Promise<Map<string, number>> {
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
