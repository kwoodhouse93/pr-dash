import { summarizeReviews } from '../shared/approval.ts'
import { checksFromRaw, type RawCheck, type RawCheckSuite, shadowedRuns } from '../shared/map.ts'
import type { LivePull, RemotePullState } from '../shared/queue.ts'
import { graphql, messageFrom, rest } from './github-client.ts'
import { ACTION_SUITES, fetchBehind, readCommitChecks } from './github.ts'

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
