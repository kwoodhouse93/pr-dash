import type { PullRequest } from '../shared/types.ts'

type LinearIssue = {
  identifier: string
  title: string
  url: string
  project: { id: string; name: string } | null
}

export async function enrichLinearProjects(pullRequests: PullRequest[], token: string): Promise<void> {
  const identifiers = [...new Set(pullRequests.flatMap((pr) => pr.linearIssues.map((issue) => issue.identifier)))]
  const found = new Map<string, LinearIssue>()
  const queue = identifiers.slice()
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const identifier = queue.shift()
      if (!identifier) return
      const issue = await fetchIssue(token, identifier)
      if (issue) found.set(issue.identifier.toUpperCase(), issue)
    }
  })
  await Promise.all(workers)
  for (const pr of pullRequests) {
    for (const issue of pr.linearIssues) {
      const match = found.get(issue.identifier.toUpperCase())
      if (!match) continue
      issue.title = match.title || issue.title
      issue.url = match.url || issue.url
      issue.projectId = match.project?.id ?? null
      issue.projectName = match.project?.name ?? null
    }
  }
}

async function fetchIssue(token: string, identifier: string): Promise<LinearIssue | null> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($id: String!) { issue(id: $id) { identifier title url project { id name } } }`,
      variables: { id: identifier },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) return null
  const body = (await response.json()) as { data?: { issue: LinearIssue | null } }
  return body.data?.issue ?? null
}
