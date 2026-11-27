import type { CiLevel, MergeMark, PullRequest } from './types.ts'
import { worstCi } from './ci.ts'

/** Which pull request each one is based on, by key. Null at the bottom of the stack. */
export type Parents = Record<string, string | null>

export type Stack = {
  id: string
  repo: string
  trunk: string
  /** Every pull request once, each above the one it is based on. A branch keeps its rows together. */
  prs: PullRequest[]
  parents: Parents
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
  /** Earliest time a pull request that is out of draft became ready for review. Null when every one is a draft. */
  readyAt: string | null
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

/** The chosen pull request and each one below it, the chosen one first. */
export function downstackKeys(parents: Parents, key: string): string[] {
  if (!(key in parents)) return []
  const path: string[] = []
  const guard = new Set<string>()
  let current: string | null = key
  while (current != null && !guard.has(current)) {
    guard.add(current)
    path.push(current)
    current = parents[current] ?? null
  }
  return path
}

/** Every pull request stacked above the chosen one, on any branch, each after the one it is based on. */
export function upstackKeys(order: string[], parents: Parents, key: string): string[] {
  const above = new Set<string>([key])
  const found: string[] = []
  for (let index = order.length - 1; index >= 0; index--) {
    const candidate = order[index]!
    const parent = parents[candidate]
    if (candidate === key || parent == null || !above.has(parent)) continue
    above.add(candidate)
    found.push(candidate)
  }
  return found
}

/**
 * The stack as one merge sees it: every other pull request first, then the chosen one down to the trunk.
 * What comes before the chosen pull request is restacked when it and those below it merge.
 */
export function mergeLineKeys(order: string[], parents: Parents, key: string): string[] {
  const down = downstackKeys(parents, key)
  if (down.length === 0) return []
  const merging = new Set(down)
  return [...order.filter((item) => !merging.has(item)), ...down]
}

/** The top of the part every branch shares. On a stack with no branches this is the top pull request. */
export function leadKey(order: string[], parents: Parents): string | null {
  let current = order.find((key) => parents[key] == null) ?? null
  const guard = new Set<string>()
  while (current != null && !guard.has(current)) {
    guard.add(current)
    const children: string[] = order.filter((key) => parents[key] === current)
    if (children.length !== 1) return current
    current = children[0]!
  }
  return current
}

function pick(stack: Stack, keys: string[]): PullRequest[] {
  const byKey = new Map(stack.prs.map((pr) => [pr.key, pr]))
  return keys.flatMap((key) => {
    const pr = byKey.get(key)
    return pr ? [pr] : []
  })
}

function order(stack: Stack): string[] {
  return stack.prs.map((pr) => pr.key)
}

/** The chosen pull request, then every one stacked above it, each after the one it is based on. */
export function restackChain(stack: Stack, key: string): PullRequest[] | null {
  if (!(key in stack.parents)) return null
  return pick(stack, [key, ...upstackKeys(order(stack), stack.parents, key)])
}

/** The chosen pull request and each one below it, closest to the trunk first. */
export function downstackChain(stack: Stack, key: string): PullRequest[] | null {
  if (!(key in stack.parents)) return null
  return pick(stack, downstackKeys(stack.parents, key).reverse())
}

/** Top to bottom for one merge: what is restacked, then the chosen pull request down to the trunk. */
export function mergeLine(stack: Stack, key: string): PullRequest[] | null {
  if (!(key in stack.parents)) return null
  return pick(stack, mergeLineKeys(order(stack), stack.parents, key))
}

export function stackOf(stacks: Stack[], key: string): Stack | null {
  return stacks.find((stack) => key in stack.parents) ?? null
}

export function buildStacks(prs: PullRequest[]): Stack[] {
  const byRepo = new Map<string, PullRequest[]>()
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? []
    list.push(pr)
    byRepo.set(pr.repo, list)
  }
  const stacks: Stack[] = []
  for (const [repo, group] of byRepo) stacks.push(...trees(repo, group))
  return stacks
}

/** One stack for each pull request that sits on the trunk, with every branch that grows from it. */
function trees(repo: string, group: PullRequest[]): Stack[] {
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
  const children = new Map<string, PullRequest[]>()
  const roots: PullRequest[] = []
  for (const pr of group) {
    const parent = parentOf(pr)
    if (!parent) {
      roots.push(pr)
      continue
    }
    const list = children.get(parent.id) ?? []
    list.push(pr)
    children.set(parent.id, list)
  }
  roots.sort((a, b) => b.number - a.number)
  const stacks: Stack[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const prs: PullRequest[] = []
    const parents: Parents = {}
    const size = new Map<string, number>()
    const measure = (pr: PullRequest): number => {
      const total = 1 + (children.get(pr.id) ?? []).reduce((sum, child) => sum + measure(child), 0)
      size.set(pr.id, total)
      return total
    }
    measure(root)
    // The longest branch goes first, so it keeps the straight rail.
    const visit = (pr: PullRequest, parent: PullRequest | null) => {
      seen.add(pr.id)
      parents[pr.key] = parent?.key ?? null
      const above = (children.get(pr.id) ?? []).slice().sort((a, b) => size.get(b.id)! - size.get(a.id)! || a.number - b.number)
      for (const child of above) visit(child, pr)
      prs.push(pr)
    }
    visit(root, null)
    stacks.push({ id: `${repo}:${root.id}`, repo, trunk: root.baseRef, prs, parents })
  }
  // Pull requests based on each other in a loop have no bottom, so each stands alone.
  for (const pr of group) {
    if (seen.has(pr.id)) continue
    stacks.push({ id: `${repo}:${pr.id}`, repo, trunk: pr.baseRef, prs: [pr], parents: { [pr.key]: null } })
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

/** `lead` is the pull request the row is named after. It defaults to the first one. */
export function summarize(prs: PullRequest[], partial: boolean, lead: PullRequest | null = null): StackSummary {
  const top = lead ?? prs[0]!
  const merge = worstMerge(prs)
  const updatedAt = prs
    .map((pr) => pr.updatedAt)
    .sort()
    .at(-1)!
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
    readyAt:
      prs
        .filter((pr) => !pr.isDraft)
        .map((pr) => pr.readyAt ?? pr.createdAt)
        .sort()[0] ?? null,
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
