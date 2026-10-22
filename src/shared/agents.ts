import { checkPhase, selectChecks } from './ci.ts'
import { cursorSessionActive } from './cursor.ts'
import type { AgentKind, Check, CursorSession, PullRequest } from './types.ts'

/** A review thread, trimmed to what Cursor needs in order to fix it. */
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
  conflict: 'Cursor is resolving the merge conflict on this pull request.',
  ci: 'Cursor is investigating the failing checks on this pull request.',
  prompt: 'Cursor is working on this pull request.',
  thread: 'Cursor is fixing a review thread on this pull request.',
}

export function agentKindLabel(kind: AgentKind): string {
  return KIND_LABEL[kind]
}

export function agentWork(kind: AgentKind): string {
  return KIND_WORK[kind]
}

export function failingChecks(pr: PullRequest): Check[] {
  return selectChecks(pr.checks).filter((check) => checkPhase(check) === 'fail')
}

export function activeSession(pr: PullRequest, kind: AgentKind): CursorSession | null {
  return (pr.cursorSessions ?? []).find((session) => session.kind === kind && cursorSessionActive(session.status)) ?? null
}

/**
 * Why this agent cannot start on this pull request, or null when it can.
 * A shortcut runs once at a time on a pull request. Prompts and review-thread fixes can run side by side.
 */
export function agentBlocker(pr: PullRequest, request: AgentRequest): string | null {
  switch (request.kind) {
    case 'conflict':
      if (!pr.conflict) return 'That pull request no longer has a merge conflict.'
      if (activeSession(pr, 'conflict')) return 'Cursor is already resolving this conflict.'
      return null
    case 'ci':
      if (failingChecks(pr).length === 0) return 'That pull request has no failing checks.'
      if (activeSession(pr, 'ci')) return 'Cursor is already investigating these checks.'
      return null
    case 'prompt':
      if (!request.prompt.trim()) return 'Write a prompt for Cursor.'
      if (request.prompt.length > PROMPT_LIMIT) return `Keep the prompt under ${PROMPT_LIMIT.toLocaleString('en-US')} characters.`
      return null
    case 'thread':
      if (!request.thread.comments.some((comment) => comment.body.trim())) return 'That thread has nothing for Cursor to fix.'
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
