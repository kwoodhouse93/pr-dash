import { sessionNote } from '../shared/agents.ts'
import { cursorLinks, cursorPushedBranch, cursorSessionStatus } from '../shared/cursor.ts'
import type { AgentSession } from '../shared/types.ts'
import { AgentUnavailable, newSession, type AgentProvider, type AgentStart } from './agent-provider.ts'
import { requestSignal } from './request-signal.ts'

const CURSOR_API = 'https://api.cursor.com/v1/agents'

type CursorErrorBody = { message?: string; error?: { message?: string } | string }

type CursorCreateResponse = CursorErrorBody & {
  agent?: { id?: string; latestRunId?: string }
  run?: { id?: string; status?: string }
  id?: string
}

type CursorAgentResponse = CursorErrorBody & {
  latestRunId?: string
}

type CursorRunResponse = CursorErrorBody & {
  id?: string
  status?: string
  result?: string
  git?: { branches?: { branch?: string | null }[] }
}

const NO_KEY = 'Set CURSOR_API_KEY on the server to start Cursor agents.'

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  async health() {
    return process.env.CURSOR_API_KEY ? { state: 'ready', detail: null } : { state: 'unconfigured', detail: NO_KEY }
  },
  start: startCursorAgent,
  read: (session) => reaching(() => readCursorSession(cursorKey(), session)),
}

async function startCursorAgent({ pr, request, task }: AgentStart): Promise<AgentSession> {
  const apiKey = cursorKey()
  const body = await reaching(() =>
    cursorPost<CursorCreateResponse>(apiKey, CURSOR_API, {
      name: task.name,
      prompt: { text: task.prompt },
      repos: [{ url: `https://github.com/${pr.repo}`, prUrl: pr.url }],
      workOnCurrentBranch: true,
      autoCreatePR: false,
    }),
  )
  const agentId = body.agent?.id ?? body.id
  const runId = body.run?.id ?? body.agent?.latestRunId
  if (!agentId || !runId) throw new Error('Cursor started without returning an agent link.')
  return newSession('cursor', {
    agentId,
    runId,
    kind: request.kind,
    prompt: sessionNote(request),
    status: cursorSessionStatus(body.run?.status),
    url: cursorLinks(agentId).webUrl,
  })
}

async function readCursorSession(apiKey: string, session: AgentSession): Promise<AgentSession> {
  const agent = await cursorGet<CursorAgentResponse>(apiKey, `${CURSOR_API}/${encodeURIComponent(session.agentId)}`)
  const runId = agent.latestRunId || session.runId
  const run = await cursorGet<CursorRunResponse>(apiKey, `${CURSOR_API}/${encodeURIComponent(session.agentId)}/runs/${encodeURIComponent(runId)}`)
  return {
    ...session,
    runId: run.id || runId,
    status: cursorSessionStatus(run.status),
    result: run.result ?? session.result,
    branch: cursorPushedBranch(run.git) ?? session.branch,
    updatedAt: new Date().toISOString(),
  }
}

/** Cursor answered, and said no. */
class CursorRefused extends Error {}

/** A request Cursor never answered means Cursor is out of reach, not that the request was wrong. */
async function reaching<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof CursorRefused || error instanceof AgentUnavailable) throw error
    // A cancelled refresh, not a silent Cursor.
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new AgentUnavailable('unreachable', `Could not reach Cursor: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function cursorKey(): string {
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) throw new AgentUnavailable('unconfigured', NO_KEY)
  return apiKey
}

async function cursorPost<T>(apiKey: string, url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: requestSignal(60_000),
  })
  return readCursor<T>(response)
}

async function cursorGet<T>(apiKey: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: requestSignal(20_000),
  })
  return readCursor<T>(response)
}

async function readCursor<T>(response: Response): Promise<T> {
  const text = await response.text()
  const body = parseResponse(text)
  if (response.status >= 500) throw new AgentUnavailable('unreachable', cursorError(response.status, body))
  if (!response.ok) throw new CursorRefused(cursorError(response.status, body))
  return body as T
}

function parseResponse(text: string): CursorErrorBody {
  try {
    return JSON.parse(text) as CursorErrorBody
  } catch {
    return {}
  }
}

function cursorError(status: number, body: CursorErrorBody): string {
  const detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
  return detail ? `Cursor ${status}: ${detail.slice(0, 300)}` : `Cursor request failed (${status}).`
}
