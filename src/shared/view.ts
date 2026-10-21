import type { Filters, Initiative, PullRequest, Sort } from './types.ts'
import { buildStacks, summarize, type Stack, type StackSummary } from './stacks.ts'

export type ViewRow =
  | { type: 'pr'; pr: PullRequest }
  | { type: 'ellipsis'; id: string; count: number; place: 'above' | 'between' | 'below'; reason: string }

export type StackBlock = {
  id: string
  stackKeys: string[]
  collapsible: boolean
  summary: StackSummary
  rows: ViewRow[]
}

export type Bucket = {
  id: string
  title: string | null
  href: string | null
  meta: string | null
  count: number
  issueId: string | null
  stacks: StackBlock[]
  singles: StackBlock[]
}

export type ProjectGroup = {
  id: string
  title: string
  issues: Bucket[]
}

export type Outline = {
  projects: ProjectGroup[]
  initiatives: Bucket[]
  looseIssues: Bucket[]
  unassigned: Bucket | null
}

export type Attention = 'author' | 'reviewer'

export function needsAttention(pr: PullRequest, attention: Attention): boolean {
  if (attention === 'reviewer') return (pr.unreadCount ?? 0) > 0 || (pr.reviewCommentAwaitingCount ?? 0) > 0
  return (pr.awaitingYouCount ?? 0) > 0 || (pr.commentAwaitingCount ?? 0) > 0
}

export function prMatches(
  pr: PullRequest,
  filters: Filters,
  initiativeNames: Map<string, string>,
  attention: Attention = 'author',
): boolean {
  if (filters.repo && pr.repo !== filters.repo) return false
  if (filters.hideDrafts && pr.isDraft) return false
  if (filters.ci !== 'all' && pr.ci !== filters.ci) return false
  if (filters.awaitingOnly && !needsAttention(pr, attention)) return false
  if (filters.initiativeId === 'none' && pr.initiativeIds.length > 0) return false
  if (
    filters.initiativeId &&
    filters.initiativeId !== 'none' &&
    !pr.initiativeIds.includes(filters.initiativeId)
  ) {
    return false
  }
  if (filters.review === 'unmet' && pr.mergeMark !== 'unmet') return false
  if (filters.review === 'met' && pr.mergeMark !== 'met') return false
  if (filters.review === 'human' && !pr.humanApproval) return false
  if (filters.review === 'changes' && !pr.changesRequested) return false
  if (filters.review === 'none' && pr.anyApproval) return false
  const query = filters.query.trim().toLowerCase()
  if (query) {
    const haystack = [
      pr.title,
      pr.author,
      pr.repo,
      pr.repoName,
      String(pr.number),
      pr.headRef,
      ...pr.linearIssues.flatMap((issue) => [issue.identifier, issue.title ?? '']),
      ...pr.initiativeIds.map((id) => initiativeNames.get(id) ?? ''),
    ]
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(query)) return false
  }
  return true
}

function ellipsisRows(
  ordered: PullRequest[],
  include: (pr: PullRequest) => boolean,
  reasonFor: (pr: PullRequest) => string,
): ViewRow[] {
  const rows: ViewRow[] = []
  let gap: PullRequest[] = []
  let started = false
  const flush = (place: 'above' | 'between' | 'below') => {
    if (gap.length === 0) return
    const reasons = new Set(gap.map(reasonFor))
    const reason = reasons.size === 1 ? [...reasons][0]! : 'not in this view'
    rows.push({
      type: 'ellipsis',
      id: `gap-${gap.map((pr) => pr.id).join('-')}`,
      count: gap.length,
      place,
      reason,
    })
    gap = []
  }
  for (const pr of ordered) {
    if (!include(pr)) {
      gap.push(pr)
      continue
    }
    flush(started ? 'between' : 'above')
    started = true
    rows.push({ type: 'pr', pr })
  }
  if (started) flush('below')
  return rows
}

function toBlock(
  stack: Stack,
  inGroup: (pr: PullRequest) => boolean,
  matches: (pr: PullRequest) => boolean,
  outsideReason: string,
): StackBlock | null {
  const include = (pr: PullRequest) => inGroup(pr) && matches(pr)
  if (!stack.prs.some(include)) return null
  const rows = ellipsisRows(stack.prs, include, (pr) => (inGroup(pr) ? 'filtered out' : outsideReason))
  const visible = rows.flatMap((row) => (row.type === 'pr' ? [row.pr] : []))
  const partial = rows.some((row) => row.type === 'ellipsis')
  return {
    id: stack.id,
    stackKeys: stack.prs.map((pr) => pr.key),
    collapsible: visible.length > 1 || partial,
    summary: summarize(visible, partial),
    rows,
  }
}

function blockStamp(block: StackBlock, sort: Sort): number | string {
  const summary = block.summary
  switch (sort.key) {
    case 'updated':
      return Date.parse(summary.updatedAt)
    case 'created':
      return Date.parse(summary.createdAt)
    case 'size':
      return summary.additions + summary.deletions
    case 'title':
      return summary.title.toLowerCase()
    case 'repo':
      return summary.repoName.toLowerCase()
    case 'ci':
      return ciRank(summary.ci)
  }
}

function ciRank(level: StackSummary['ci']): number {
  switch (level) {
    case 'red':
      return 4
    case 'yellow':
      return 3
    case 'pending':
      return 2
    case 'green':
      return 1
    case 'none':
      return 0
  }
}

function compareValues(a: number | string, b: number | string, sort: Sort): number {
  const delta = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
  return sort.dir === 'asc' ? delta : -delta
}

function sortBlocks(blocks: StackBlock[], sort: Sort): StackBlock[] {
  return blocks.slice().sort((a, b) => compareValues(blockStamp(a, sort), blockStamp(b, sort), sort))
}

function blocksStamp(blocks: StackBlock[], sort: Sort): number | string {
  const stamps = blocks.map((block) => blockStamp(block, sort))
  if (typeof stamps[0] === 'string') {
    const texts = stamps.map(String).sort()
    return sort.dir === 'desc' ? texts.at(-1)! : texts[0]!
  }
  const nums = stamps as number[]
  return sort.dir === 'desc' ? Math.max(...nums) : Math.min(...nums)
}

function sortBuckets(buckets: Bucket[], sort: Sort): Bucket[] {
  return buckets.slice().sort((a, b) =>
    compareValues(blocksStamp([...a.stacks, ...a.singles], sort), blocksStamp([...b.stacks, ...b.singles], sort), sort),
  )
}

function visibleCount(blocks: StackBlock[]): number {
  return blocks.reduce(
    (total, block) => total + block.rows.filter((row) => row.type === 'pr').length,
    0,
  )
}

function toBucket(
  id: string,
  title: string | null,
  href: string | null,
  issueId: string | null,
  blocks: StackBlock[],
): Bucket | null {
  if (blocks.length === 0) return null
  const stacks: StackBlock[] = []
  const singles: StackBlock[] = []
  for (const block of blocks) {
    const visible = block.rows.filter((row) => row.type === 'pr').length
    const partial = block.rows.some((row) => row.type === 'ellipsis')
    if (visible > 1 || partial) stacks.push(block)
    else singles.push(block)
  }
  const count = visibleCount(blocks)
  return { id, title, href, meta: countLabel(count), count, issueId, stacks, singles }
}

function hasProject(pr: PullRequest): boolean {
  return pr.linearIssues.some((issue) => issue.projectName)
}

function issueTitle(identifier: string, title: string | null): string {
  return title ? `${identifier} · ${title}` : identifier
}

export function outlineEmpty(outline: Outline): boolean {
  return (
    outline.projects.length === 0 &&
    outline.initiatives.length === 0 &&
    outline.looseIssues.length === 0 &&
    outline.unassigned === null
  )
}

export function buildOutline(
  prs: PullRequest[],
  initiatives: Initiative[],
  filters: Filters,
  sort: Sort,
  attention: Attention = 'author',
): Outline {
  const names = new Map(initiatives.map((initiative) => [initiative.id, initiative.name]))
  const matches = (pr: PullRequest) => prMatches(pr, filters, names, attention)
  const stacks = buildStacks(prs)
  const blocksFor = (inGroup: (pr: PullRequest) => boolean, outsideReason: string) =>
    sortBlocks(
      stacks.flatMap((stack) => {
        const block = toBlock(stack, inGroup, matches, outsideReason)
        return block ? [block] : []
      }),
      sort,
    )

  const projectIssues = new Map<string, { project: string; identifier: string; title: string; href: string | null }>()
  const looseIssues = new Map<string, { identifier: string; title: string; href: string | null }>()
  for (const pr of prs) {
    const inProject = pr.linearIssues.filter((issue) => issue.projectName)
    if (inProject.length) {
      for (const issue of inProject) {
        const key = `${issue.projectName}\0${issue.identifier}`
        if (projectIssues.has(key)) continue
        projectIssues.set(key, {
          project: issue.projectName!,
          identifier: issue.identifier,
          title: issueTitle(issue.identifier, issue.title),
          href: issue.url,
        })
      }
      continue
    }
    if (pr.initiativeIds.length) continue
    for (const issue of pr.linearIssues) {
      if (looseIssues.has(issue.identifier)) continue
      looseIssues.set(issue.identifier, {
        identifier: issue.identifier,
        title: issueTitle(issue.identifier, issue.title),
        href: issue.url,
      })
    }
  }

  const byProject = new Map<string, { identifier: string; title: string; href: string | null }[]>()
  for (const issue of projectIssues.values()) {
    const list = byProject.get(issue.project) ?? []
    list.push(issue)
    byProject.set(issue.project, list)
  }

  const projects: ProjectGroup[] = []
  for (const [project, issues] of byProject) {
    const buckets = sortBuckets(
      issues.flatMap((issue) => {
        const bucket = toBucket(
          `project:${project}:${issue.identifier}`,
          issue.title,
          issue.href,
          issue.identifier,
          blocksFor(
            (pr) =>
              pr.linearIssues.some((item) => item.projectName === project && item.identifier === issue.identifier),
            'other issues',
          ),
        )
        return bucket ? [bucket] : []
      }),
      sort,
    )
    if (buckets.length === 0) continue
    projects.push({ id: `project:${project}`, title: project, issues: buckets })
  }
  projects.sort((a, b) =>
    compareValues(
      blocksStamp(
        a.issues.flatMap((issue) => [...issue.stacks, ...issue.singles]),
        sort,
      ),
      blocksStamp(
        b.issues.flatMap((issue) => [...issue.stacks, ...issue.singles]),
        sort,
      ),
      sort,
    ),
  )

  const initiativeBuckets = sortBuckets(
    initiatives.flatMap((initiative) => {
      const bucket = toBucket(
        `initiative:${initiative.id}`,
        initiative.name,
        null,
        null,
        blocksFor((pr) => !hasProject(pr) && pr.initiativeIds.includes(initiative.id), 'not in this initiative'),
      )
      return bucket ? [bucket] : []
    }),
    sort,
  )

  const loose = sortBuckets(
    [...looseIssues.values()].flatMap((issue) => {
      const bucket = toBucket(
        `loose:${issue.identifier}`,
        issue.title,
        issue.href,
        issue.identifier,
        blocksFor(
          (pr) =>
            !hasProject(pr) &&
            pr.initiativeIds.length === 0 &&
            pr.linearIssues.some((item) => item.identifier === issue.identifier),
          'other issues',
        ),
      )
      return bucket ? [bucket] : []
    }),
    sort,
  )

  return {
    projects,
    initiatives: initiativeBuckets,
    looseIssues: loose,
    unassigned: toBucket(
      'unassigned',
      null,
      null,
      null,
      blocksFor(
        (pr) => !hasProject(pr) && pr.initiativeIds.length === 0 && pr.linearIssues.length === 0,
        'grouped elsewhere',
      ),
    ),
  }
}

function countLabel(count: number): string {
  return count === 1 ? '1 pull request' : `${count} pull requests`
}
