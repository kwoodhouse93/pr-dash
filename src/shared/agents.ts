import { checkPhase, selectChecks } from './ci.ts'
import { cursorSessionActive } from './cursor.ts'
import type { AgentKind, Check, CursorSession, PullRequest } from './types.ts'

export type AgentRequest = { kind: 'conflict' } | { kind: 'ci' } | { kind: 'prompt'; prompt: string }

export const PROMPT_LIMIT = 8000

const KIND_LABEL: Record<AgentKind, string> = {
  conflict: 'Merge conflict',
  ci: 'CI failure',
  prompt: 'Prompt',
}

const KIND_WORK: Record<AgentKind, string> = {
  conflict: 'Cursor is resolving the merge conflict on this pull request.',
  ci: 'Cursor is investigating the failing checks on this pull request.',
  prompt: 'Cursor is working on this pull request.',
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
 * A shortcut runs once at a time on a pull request. Prompts can run side by side.
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
  }
}

export function parseAgentRequest(body: unknown): AgentRequest | null {
  if (!body || typeof body !== 'object') return null
  const { kind, prompt } = body as { kind?: unknown; prompt?: unknown }
  if (kind === 'conflict' || kind === 'ci') return { kind }
  if (kind === 'prompt' && typeof prompt === 'string') return { kind, prompt }
  return null
}
