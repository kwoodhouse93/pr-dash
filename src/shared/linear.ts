import type { LinearIssue, PullRequest } from './types.ts'

const ISSUE_ID = /^[A-Z][A-Z0-9]+-\d+$/

export function isLinearIdentifier(value: string): boolean {
  return ISSUE_ID.test(value)
}

export function blankIssue(identifier: string): LinearIssue {
  return {
    identifier: identifier.toUpperCase(),
    title: null,
    url: null,
    projectId: null,
    projectName: null,
    teamId: null,
    status: null,
    assignee: null,
  }
}

/** Keep issues linked from this dashboard when GitHub has not echoed them yet. */
export function mergeLinkedIssues(pr: PullRequest, identifiers: string[]): PullRequest {
  if (identifiers.length === 0) return pr
  const current = pr.linearIssues ?? []
  const have = new Set(current.map((issue) => issue.identifier.toUpperCase()))
  const extra = identifiers
    .map((identifier) => identifier.toUpperCase())
    .filter((identifier, index, all) => isLinearIdentifier(identifier) && !have.has(identifier) && all.indexOf(identifier) === index)
  if (extra.length === 0) return pr
  return { ...pr, linearIssues: [...current, ...extra.map(blankIssue)] }
}

const SUMMARY_ANCHOR = /<summary>\s*<a href="(https:\/\/linear\.app\/[^"]+\/issue\/([A-Z][A-Z0-9]+-\d+)[^"]*)">([^<]+)<\/a>/gi
const TITLE_RE = /\(([A-Z][A-Z0-9]+-\d+)\)/g
const BRANCH_RE = /(?:^|\/)([a-z]{2,}-\d+)(?!\d)/gi

function add(issues: Map<string, LinearIssue>, identifier: string, patch: Partial<LinearIssue>) {
  const id = identifier.toUpperCase()
  const existing = issues.get(id) ?? {
    identifier: id,
    title: null,
    url: null,
    projectId: null,
    projectName: null,
    teamId: null,
    status: null,
    assignee: null,
  }
  if (patch.title && !existing.title) existing.title = patch.title
  if (patch.url && !existing.url) existing.url = patch.url
  issues.set(id, existing)
}

function titleFromLinkText(identifier: string, text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.toUpperCase().startsWith(identifier.toUpperCase())) {
    const rest = trimmed.slice(identifier.length).trim()
    return rest || null
  }
  return trimmed || null
}

export function parseLinear(input: { title: string; headRef: string; comments: { body: string }[] }): LinearIssue[] {
  const issues = new Map<string, LinearIssue>()
  for (const comment of input.comments) {
    const body = comment.body ?? ''
    if (!body.includes('linear-linkback')) continue
    for (const match of body.matchAll(SUMMARY_ANCHOR)) {
      const identifier = match[2]!.toUpperCase()
      add(issues, identifier, {
        url: match[1],
        title: titleFromLinkText(identifier, match[3] ?? ''),
      })
    }
  }
  for (const match of input.title.matchAll(TITLE_RE)) add(issues, match[1]!, {})
  for (const match of input.headRef.matchAll(BRANCH_RE)) add(issues, match[1]!, {})
  return [...issues.values()]
}
