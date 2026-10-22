import type { LinearAssignee, LinearIssue, LinearStatus, PullRequest } from '../shared/types.ts'
import { requestSignal } from './request-signal.ts'

type RawState = { id: string; name: string; type: string; color: string; position?: number }
type RawUser = { id: string; name: string; displayName: string; avatarUrl?: string | null; active?: boolean }
type RawIssue = {
  identifier: string
  title: string
  url: string
  project: { id: string; name: string } | null
  team: { id: string } | null
  state: RawState | null
  assignee: RawUser | null
}

const ISSUE_FIELDS = `
  identifier
  title
  url
  project { id name }
  team { id }
  state { id name type color }
  assignee { id name displayName avatarUrl }
`

export async function enrichLinearProjects(pullRequests: PullRequest[], token: string): Promise<void> {
  const identifiers = [...new Set(pullRequests.flatMap((pr) => pr.linearIssues.map((issue) => issue.identifier)))]
  const found = new Map<string, LinearIssue>()
  const queue = identifiers.slice()
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const identifier = queue.shift()
      if (!identifier) return
      try {
        const issue = await fetchIssue(token, identifier)
        if (issue) found.set(issue.identifier.toUpperCase(), issue)
      } catch {
        // One missing issue should not drop the rest of the refresh.
      }
    }
  })
  await Promise.all(workers)
  for (const pr of pullRequests) {
    for (const issue of pr.linearIssues) {
      const match = found.get(issue.identifier.toUpperCase())
      if (!match) continue
      if (match.title) issue.title = match.title
      if (match.url) issue.url = match.url
      issue.projectId = match.projectId
      issue.projectName = match.projectName
      issue.teamId = match.teamId
      issue.status = match.status
      issue.assignee = match.assignee
    }
  }
}

export async function listStatuses(
  token: string,
  query: { teamId?: string; issue?: string },
): Promise<LinearStatus[]> {
  if (query.teamId) {
    const data = await linear<{ team: { states: { nodes: RawState[] } } | null }>(
      token,
      `query($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type color position } } } }`,
      { id: query.teamId },
    )
    return sortStates(data.team?.states.nodes ?? [])
  }
  if (!query.issue) throw new Error('A Linear team or issue is required.')
  const data = await linear<{ issue: { team: { states: { nodes: RawState[] } } | null } | null }>(
    token,
    `query($id: String!) { issue(id: $id) { team { states(first: 100) { nodes { id name type color position } } } } }`,
    { id: query.issue },
  )
  if (!data.issue) throw new Error(`Linear issue ${query.issue} was not found.`)
  return sortStates(data.issue.team?.states.nodes ?? [])
}

export async function listUsers(token: string): Promise<LinearAssignee[]> {
  const users: LinearAssignee[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const data: { users: { nodes: RawUser[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await linear(
        token,
        `query($after: String) {
          users(first: 100, after: $after) {
            nodes { id name displayName avatarUrl active }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
      )
    for (const user of data.users.nodes) {
      if (user.active === false) continue
      const mapped = mapUser(user)
      if (mapped) users.push(mapped)
    }
    if (!data.users.pageInfo.hasNextPage || !data.users.pageInfo.endCursor) break
    after = data.users.pageInfo.endCursor
  }
  users.sort((a, b) => a.name.localeCompare(b.name))
  return users
}

export async function updateLinearIssue(
  token: string,
  identifier: string,
  input: { statusId?: string; assigneeId?: string | null },
): Promise<LinearIssue> {
  const found = await linear<{ issue: { id: string } | null }>(
    token,
    `query($id: String!) { issue(id: $id) { id } }`,
    { id: identifier },
  )
  if (!found.issue) throw new Error(`Linear issue ${identifier} was not found.`)
  const patch: { stateId?: string; assigneeId?: string | null } = {}
  if (input.statusId) patch.stateId = input.statusId
  if ('assigneeId' in input) patch.assigneeId = input.assigneeId
  const data = await linear<{ issueUpdate: { success: boolean; issue: RawIssue | null } }>(
    token,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    { id: found.issue.id, input: patch },
  )
  if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not update that issue.')
  return mapIssue(data.issueUpdate.issue)
}

async function fetchIssue(token: string, identifier: string): Promise<LinearIssue | null> {
  const data = await linear<{ issue: RawIssue | null }>(
    token,
    `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: identifier },
  )
  return data.issue ? mapIssue(data.issue) : null
}

function mapIssue(issue: RawIssue): LinearIssue {
  return {
    identifier: issue.identifier.toUpperCase(),
    title: issue.title || null,
    url: issue.url || null,
    projectId: issue.project?.id ?? null,
    projectName: issue.project?.name ?? null,
    teamId: issue.team?.id ?? null,
    status: issue.state ? mapState(issue.state) : null,
    assignee: mapUser(issue.assignee),
  }
}

function mapState(state: RawState): LinearStatus {
  return {
    id: state.id,
    name: state.name,
    type: state.type.toLowerCase(),
    color: state.color,
  }
}

function mapUser(user: RawUser | null): LinearAssignee | null {
  if (!user) return null
  return {
    id: user.id,
    name: user.displayName || user.name,
    avatarUrl: user.avatarUrl ?? null,
  }
}

const STATUS_TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']

function sortStates(states: RawState[]): LinearStatus[] {
  return states
    .slice()
    .sort((a, b) => {
      const typeDelta = typeRank(a.type) - typeRank(b.type)
      if (typeDelta !== 0) return typeDelta
      return (a.position ?? 0) - (b.position ?? 0)
    })
    .map(mapState)
}

function typeRank(type: string): number {
  const index = STATUS_TYPE_ORDER.indexOf(type.toLowerCase())
  return index === -1 ? STATUS_TYPE_ORDER.length : index
}

async function linear<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: requestSignal(20_000),
  })
  if (!response.ok) throw new Error(`Linear responded ${response.status}.`)
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors[0]!.message)
  if (!body.data) throw new Error('Linear returned no data.')
  return body.data
}
