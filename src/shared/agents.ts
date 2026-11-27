import { checkPhase, selectChecks } from './ci.ts'
import { cursorLinks } from './cursor.ts'
import type { AgentKind, AgentProviderId, AgentRouting, AgentSession, AgentSessionStatus, Check, PullRequest } from './types.ts'

export const AGENT_PROVIDERS: { id: AgentProviderId; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 't3', label: 'T3 Code' },
]

export const DEFAULT_ROUTING: AgentRouting = { defaultProvider: 'cursor', repos: {} }

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return AGENT_PROVIDERS.some((provider) => provider.id === value)
}

export function providerLabel(id: AgentProviderId): string {
  return AGENT_PROVIDERS.find((provider) => provider.id === id)?.label ?? id
}

/** The provider that starts agents for this repository. */
export function providerFor(routing: AgentRouting | null | undefined, repo: string | null): AgentProviderId {
  const chosen = routing ?? DEFAULT_ROUTING
  return (repo ? chosen.repos[repo] : undefined) ?? chosen.defaultProvider
}

/** Whether a provider can be used, and why not. */
export type AgentHealth =
  | { state: 'ready'; detail: string | null }
  /** Something the user has to set up: a key, the command, a checkout folder. */
  | { state: 'unconfigured'; detail: string }
  /** Set up, but not answering now. */
  | { state: 'unreachable'; detail: string }

export type AgentSettings = {
  defaultProvider: AgentProviderId
  /** The address of the T3 Code running on this machine, or null when none is. */
  t3Origin: string | null
  providers: { id: AgentProviderId; health: AgentHealth }[]
  repos: {
    repo: string
    /** Null follows the default. */
    provider: AgentProviderId | null
    /** The project T3 Code already has for this repository, used when no folder is set. */
    project: { title: string; folder: string } | null
    /** A folder set by hand for T3 Code to work in, instead of that project. */
    checkout: string | null
    /** Why T3 Code cannot use that folder, or null. */
    checkoutProblem: string | null
  }[]
}

const STATUS_RANK: Record<AgentSessionStatus, number> = {
  waiting: 0,
  running: 1,
  creating: 2,
  failed: 3,
  finished: 4,
  cancelled: 5,
  expired: 6,
}

/** Still going, so a refresh reads it again. A session waiting for an answer is still going. */
export function sessionActive(status: AgentSessionStatus): boolean {
  return status === 'creating' || status === 'running' || status === 'waiting'
}

export function sessionStatusLabel(status: AgentSessionStatus): string {
  switch (status) {
    case 'creating':
      return 'Creating'
    case 'running':
      return 'Running'
    case 'waiting':
      return 'Needs input'
    case 'finished':
      return 'Finished'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired'
  }
}

export type AgentsSummary = { running: number; waiting: number; label: string }

/** How many agents are at work and how many wait for an answer, in the few words a button has room for. */
export function agentsSummary(statuses: AgentSessionStatus[]): AgentsSummary {
  const running = statuses.filter((status) => status === 'creating' || status === 'running').length
  const waiting = statuses.filter((status) => status === 'waiting').length
  const parts = [running > 0 ? `${running} running` : null, waiting > 0 ? `${waiting} waiting for you` : null].filter(Boolean)
  return { running, waiting, label: parts.length > 0 ? `Agents: ${parts.join(', ')}` : 'Agents' }
}

export function leadingStatus(statuses: AgentSessionStatus[]): AgentSessionStatus | null {
  if (statuses.length === 0) return null
  return [...statuses].sort((left, right) => STATUS_RANK[left] - STATUS_RANK[right])[0] ?? null
}

/**
 * A T3 Code thread's page in the T3 Code that runs on this machine, from the link T3 Code gives for it.
 * `origin` is that T3 Code's address, known once this browser is paired with it. Null without one.
 */
export function t3ThreadUrl(origin: string | null | undefined, link: string | null): string | null {
  if (!origin || !link) return null
  try {
    const { pathname } = new URL(link)
    return pathname.startsWith('/threads/') ? new URL(pathname, origin).toString() : null
  } catch {
    return null
  }
}

/**
 * Where a session opens. `webUrl` is a page to show in a tab. `appUrl` hands off to the provider's own app.
 * A T3 Code thread only has a page to show once this browser is paired with T3 Code; until then its link hands off.
 */
export function sessionLinks(
  session: Pick<AgentSession, 'provider' | 'agentId' | 'url'>,
  t3Origin?: string | null,
): { webUrl: string | null; appUrl: string | null } {
  if (session.provider === 'cursor') {
    const links = cursorLinks(session.agentId)
    return { webUrl: session.url ?? links.webUrl, appUrl: links.desktopUrl }
  }
  const local = t3ThreadUrl(t3Origin, session.url)
  return local ? { webUrl: local, appUrl: session.url } : { webUrl: session.url, appUrl: null }
}

/** A review thread, trimmed to what an agent needs in order to fix it. */
export type ThreadFix = {
  /** GitHub's node ID for the review thread, used to reply to and resolve it. */
  id: string | null
  path: string | null
  line: number | null
  startLine: number | null
  url: string | null
  outdated: boolean
  diffHunk: string | null
  /** Earlier comments or a long diff were left out. */
  truncated: boolean
  comments: { author: string | null; body: string }[]
}

export type AgentRequest =
  | { kind: 'conflict' }
  | { kind: 'ci' }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'thread'; thread: ThreadFix; prompt: string | null }

export const PROMPT_LIMIT = 8000
const THREAD_COMMENTS = 30
const THREAD_BODY = 6000
const THREAD_HUNK = 16_000
const THREAD_PATH = 500

const KIND_LABEL: Record<AgentKind, string> = {
  conflict: 'Merge conflict',
  ci: 'CI failure',
  prompt: 'Prompt',
  thread: 'Review thread',
}

const KIND_WORK: Record<AgentKind, string> = {
  conflict: 'is resolving the merge conflict on this pull request.',
  ci: 'is investigating the failing checks on this pull request.',
  prompt: 'is working on this pull request.',
  thread: 'is fixing a review thread on this pull request.',
}

export function agentKindLabel(kind: AgentKind): string {
  return KIND_LABEL[kind]
}

export function agentWork(kind: AgentKind, provider: AgentProviderId = 'cursor'): string {
  return `${providerLabel(provider)} ${KIND_WORK[kind]}`
}

export function failingChecks(pr: PullRequest): Check[] {
  return selectChecks(pr.checks).filter((check) => checkPhase(check) === 'fail')
}

export function activeSession(pr: PullRequest, kind: AgentKind): AgentSession | null {
  return (pr.agentSessions ?? []).find((session) => session.kind === kind && sessionActive(session.status)) ?? null
}

/**
 * Why this agent cannot start on this pull request, or null when it can.
 * A shortcut runs once at a time on a pull request. Prompts and review-thread fixes can run side by side.
 */
export function agentBlocker(pr: PullRequest, request: AgentRequest): string | null {
  switch (request.kind) {
    case 'conflict':
      if (!pr.conflict) return 'That pull request no longer has a merge conflict.'
      if (activeSession(pr, 'conflict')) return 'An agent is already resolving this conflict.'
      return null
    case 'ci':
      if (failingChecks(pr).length === 0) return 'That pull request has no failing checks.'
      if (activeSession(pr, 'ci')) return 'An agent is already investigating these checks.'
      return null
    case 'prompt':
      if (!request.prompt.trim()) return 'Write a prompt for the agent.'
      if (request.prompt.length > PROMPT_LIMIT) return `Keep the prompt under ${PROMPT_LIMIT.toLocaleString('en-US')} characters.`
      return null
    case 'thread':
      if (!request.thread.comments.some((comment) => comment.body.trim())) return 'That thread has nothing for an agent to fix.'
      if (request.prompt && request.prompt.length > PROMPT_LIMIT) return `Keep the prompt under ${PROMPT_LIMIT.toLocaleString('en-US')} characters.`
      return null
  }
}

/** Text stored on the session so the Agents column can say what was asked. */
export function sessionNote(request: AgentRequest): string | null {
  if (request.kind === 'prompt') return request.prompt.trim()
  if (request.kind !== 'thread') return null
  const extra = request.prompt?.trim()
  const place = threadPlace(request.thread)
  return extra ? `${place}\n\n${extra}` : place
}

const STARTING = 'pr-dash-agent='

/**
 * The address of the empty tab the dashboard opens for an agent it is about to start.
 * It names the pull request and what was asked, so the desktop app can file the tab before the agent exists.
 */
export function startingTabUrl(key: string, request: AgentRequest): string {
  const note = sessionNote(request)?.split('\n')[0]?.trim() || null
  return `about:blank#${STARTING}${encodeURIComponent(JSON.stringify({ key, kind: request.kind, prompt: note }))}`
}

export type StartingAgent = { key: string; kind: AgentKind; prompt: string | null }

export function startingAgent(url: string): StartingAgent | null {
  if (!url.startsWith(`about:blank#${STARTING}`)) return null
  try {
    const { key, kind, prompt } = JSON.parse(decodeURIComponent(url.slice(url.indexOf('=') + 1))) as Record<string, unknown>
    if (typeof key !== 'string' || typeof kind !== 'string' || !(kind in KIND_LABEL)) return null
    return { key, kind: kind as AgentKind, prompt: typeof prompt === 'string' ? prompt : null }
  } catch {
    return null
  }
}

export function threadPlace(thread: ThreadFix): string {
  const path = thread.path?.trim() || 'Discussion'
  if (thread.startLine && thread.line && thread.startLine !== thread.line) return `${path}:${thread.startLine}-${thread.line}`
  if (thread.line) return `${path}:${thread.line}`
  return path
}

export function parseAgentRequest(body: unknown): AgentRequest | null {
  if (!body || typeof body !== 'object') return null
  const { kind, prompt, thread } = body as { kind?: unknown; prompt?: unknown; thread?: unknown }
  if (kind === 'conflict' || kind === 'ci') return { kind }
  if (kind === 'prompt' && typeof prompt === 'string') return { kind, prompt }
  if (kind === 'thread') {
    const parsed = parseThreadFix(thread)
    if (!parsed) return null
    return { kind, thread: parsed, prompt: typeof prompt === 'string' ? prompt : null }
  }
  return null
}

function parseThreadFix(value: unknown): ThreadFix | null {
  if (!value || typeof value !== 'object') return null
  const thread = value as Record<string, unknown>
  if (!Array.isArray(thread.comments)) return null
  const id = thread.id == null ? null : typeof thread.id === 'string' && /^[\w-]{1,200}$/.test(thread.id) ? thread.id : undefined
  if (id === undefined) return null
  const path = clipText(thread.path, THREAD_PATH)
  const url = clipText(thread.url, THREAD_PATH)
  const line = clipLine(thread.line)
  const startLine = clipLine(thread.startLine)
  const hunk = clipText(thread.diffHunk, THREAD_HUNK)
  if (path === undefined || url === undefined || line === undefined || startLine === undefined || hunk === undefined) return null
  if (typeof thread.outdated !== 'boolean') return null
  let truncated = thread.truncated === true
  const raw = thread.comments
  if (raw.length > THREAD_COMMENTS) truncated = true
  const comments: ThreadFix['comments'] = []
  for (const item of raw.slice(0, THREAD_COMMENTS)) {
    if (!item || typeof item !== 'object') return null
    const comment = item as { author?: unknown; body?: unknown }
    if (comment.author !== null && typeof comment.author !== 'string') return null
    if (typeof comment.body !== 'string') return null
    const body = comment.body.length > THREAD_BODY ? comment.body.slice(0, THREAD_BODY) : comment.body
    if (body.length !== comment.body.length) truncated = true
    comments.push({ author: comment.author ?? null, body })
  }
  const diffHunk = hunk === null ? null : hunk.text
  if (hunk?.clipped) truncated = true
  return {
    id,
    path: path?.text ?? null,
    line,
    startLine,
    url: url?.text ?? null,
    outdated: thread.outdated,
    diffHunk,
    truncated,
    comments,
  }
}

function clipLine(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1_000_000) return value
  return undefined
}

function clipText(value: unknown, limit: number): { text: string; clipped: boolean } | null | undefined {
  if (value == null) return null
  if (typeof value !== 'string') return undefined
  if (value.length <= limit) return { text: value, clipped: false }
  return { text: value.slice(0, limit), clipped: true }
}
