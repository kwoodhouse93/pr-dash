import type { CiLevel, MergeMark, PullRequest } from './types.ts'
import { worstCi } from './ci.ts'

export type Stack = {
  id: string
  repo: string
  trunk: string
  prs: PullRequest[]
}

export type StackSummary = {
  title: string
  url: string
  repo: string
  repoName: string
  number: number
  extra: number
  additions: number
  deletions: number
  changedFiles: number
  createdAt: string
  updatedAt: string
  ci: CiLevel
  anyApproval: boolean
  humanApproval: boolean
  changesRequested: boolean
  mergeMark: MergeMark
  mergeDetail: string
  threadCount: number
  unresolvedCount: number
  awaitingYouCount: number
  unreadCount: number
  resolvedUnreadCount: number
  awaitingThreadUrl: string | null
  unresolvedThreadUrl: string | null
  unreadThreadUrl: string | null
  resolvedUnreadThreadUrl: string | null
  commentAwaitingCount: number
  reviewCommentAwaitingCount: number
  authors: { login: string; avatarUrl: string | null }[]
  draftCount: number
  conflict: boolean
  behind: boolean
  partial: boolean
  initiativeIds: string[]
  topId: string
  topKey: string
}

/** The chosen pull request, then each one stacked above it, bottom-up. */
export function restackChain(orderedTopToBottom: PullRequest[], key: string): PullRequest[] | null {
  const index = orderedTopToBottom.findIndex((pr) => pr.key === key)
  if (index < 0) return null
  return orderedTopToBottom.slice(0, index + 1).reverse()
}

/** The chosen pull request and each one below it, closest to the trunk first. */
export function downstackChain(orderedTopToBottom: PullRequest[], key: string): PullRequest[] | null {
  const index = orderedTopToBottom.findIndex((pr) => pr.key === key)
  if (index < 0) return null
  return orderedTopToBottom.slice(index).reverse()
}

export function buildStacks(prs: PullRequest[]): Stack[] {
  const byRepo = new Map<string, PullRequest[]>()
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? []
    list.push(pr)
    byRepo.set(pr.repo, list)
  }
  const stacks: Stack[] = []
  for (const [repo, group] of byRepo) stacks.push(...chains(repo, group))
  return stacks
}

function chains(repo: string, group: PullRequest[]): Stack[] {
  const byHead = new Map<string, PullRequest[]>()
  for (const pr of group) {
    const list = byHead.get(pr.headRef) ?? []
    list.push(pr)
    byHead.set(pr.headRef, list)
  }
  const parentOf = (pr: PullRequest): PullRequest | null => {
    const candidates = (byHead.get(pr.baseRef) ?? []).filter((other) => other.id !== pr.id)
    return candidates.length === 1 ? candidates[0]! : null
  }
  const childCount = new Map<string, number>()
  for (const pr of group) {
    const parent = parentOf(pr)
    if (!parent) continue
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1)
  }
  const heads = group.filter((pr) => !childCount.get(pr.id))
  heads.sort((a, b) => b.number - a.number)
  const stacks: Stack[] = []
  const seen = new Set<string>()
  for (const head of heads) {
    const path: PullRequest[] = []
    const guard = new Set<string>()
    let current: PullRequest | null = head
    while (current && !guard.has(current.id)) {
      guard.add(current.id)
      path.push(current)
      seen.add(current.id)
      current = parentOf(current)
    }
    const root = path.at(-1)!
    stacks.push({
      id: `${repo}:${root.id}:${head.id}`,
      repo,
      trunk: root.baseRef,
      prs: path,
    })
  }
  for (const pr of group) {
    if (seen.has(pr.id)) continue
    stacks.push({ id: `${repo}:${pr.id}:${pr.id}`, repo, trunk: pr.baseRef, prs: [pr] })
  }
  return stacks
}

function authorsOf(prs: PullRequest[]): { login: string; avatarUrl: string | null }[] {
  const authors: { login: string; avatarUrl: string | null }[] = []
  const seen = new Set<string>()
  for (const pr of prs) {
    if (seen.has(pr.author)) continue
    seen.add(pr.author)
    authors.push({ login: pr.author, avatarUrl: pr.authorAvatarUrl ?? null })
  }
  return authors
}

function sum(prs: PullRequest[], pick: (pr: PullRequest) => number): number {
  return prs.reduce((total, pr) => total + pick(pr), 0)
}

/** First permalink in stack order (top of the stack, then each pull request below it). */
function firstLink(prs: PullRequest[], pick: (pr: PullRequest) => string | null | undefined): string | null {
  for (const pr of prs) {
    const url = pick(pr)
    if (url) return url
  }
  return null
}

function worstMerge(prs: PullRequest[]): { mark: MergeMark; detail: string } {
  if (prs.length === 1) return { mark: prs[0]!.mergeMark, detail: prs[0]!.mergeDetail }
  if (prs.some((pr) => pr.changesRequested)) {
    return { mark: 'unmet', detail: 'Changes have been requested on a pull request in this stack.' }
  }
  if (prs.some((pr) => pr.mergeMark === 'unmet')) {
    return { mark: 'unmet', detail: 'A pull request in this stack still needs required review.' }
  }
  if (prs.some((pr) => pr.mergeMark === 'draft')) {
    return { mark: 'draft', detail: 'A pull request in this stack is still a draft.' }
  }
  if (prs.every((pr) => pr.mergeMark === 'met')) {
    return { mark: 'met', detail: 'Review requirements are met on every pull request in this stack.' }
  }
  if (prs.some((pr) => pr.mergeMark === 'met')) {
    return {
      mark: 'unmet',
      detail: 'Only some pull requests in this stack meet review requirements. The rest will need review once they target the trunk.',
    }
  }
  return { mark: 'none', detail: 'No review requirement applies to the pull requests in this stack.' }
}

export function summarize(prs: PullRequest[], partial: boolean): StackSummary {
  const top = prs[0]!
  const merge = worstMerge(prs)
  const updatedAt = prs.map((pr) => pr.updatedAt).sort().at(-1)!
  const createdAt = prs.map((pr) => pr.createdAt).sort()[0]!
  return {
    title: top.title,
    url: top.url,
    repo: top.repo,
    repoName: top.repoName,
    number: top.number,
    extra: prs.length - 1,
    additions: sum(prs, (pr) => pr.additions),
    deletions: sum(prs, (pr) => pr.deletions),
    changedFiles: sum(prs, (pr) => pr.changedFiles),
    createdAt,
    updatedAt,
    ci: worstCi(prs.map((pr) => pr.ci)),
    anyApproval: prs.every((pr) => pr.anyApproval),
    humanApproval: prs.every((pr) => pr.humanApproval),
    changesRequested: prs.some((pr) => pr.changesRequested),
    mergeMark: merge.mark,
    mergeDetail: merge.detail,
    threadCount: sum(prs, (pr) => pr.threadCount),
    unresolvedCount: sum(prs, (pr) => pr.unresolvedCount),
    awaitingYouCount: sum(prs, (pr) => pr.awaitingYouCount),
    unreadCount: sum(prs, (pr) => pr.unreadCount ?? 0),
    resolvedUnreadCount: sum(prs, (pr) => pr.resolvedUnreadCount ?? 0),
    awaitingThreadUrl: firstLink(prs, (pr) => pr.awaitingThreadUrl),
    unresolvedThreadUrl: firstLink(prs, (pr) => pr.unresolvedThreadUrl),
    unreadThreadUrl: firstLink(prs, (pr) => pr.unreadThreadUrl),
    resolvedUnreadThreadUrl: firstLink(prs, (pr) => pr.resolvedUnreadThreadUrl),
    commentAwaitingCount: sum(prs, (pr) => pr.commentAwaitingCount ?? 0),
    reviewCommentAwaitingCount: sum(prs, (pr) => pr.reviewCommentAwaitingCount ?? 0),
    authors: authorsOf(prs),
    draftCount: prs.filter((pr) => pr.isDraft).length,
    conflict: prs.some((pr) => pr.conflict),
    behind: prs.some((pr) => pr.behind),
    partial,
    initiativeIds: [...new Set(prs.flatMap((pr) => pr.initiativeIds))],
    topId: top.id,
    topKey: top.key,
  }
}
