import { cursorPushedBranch, cursorSessionActive, cursorSessionStatus } from '../shared/cursor.ts'
import type { CursorSession, PullRequest } from '../shared/types.ts'

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

export async function startCursorConflictResolver(pr: PullRequest): Promise<CursorSession> {
  const apiKey = cursorKey()
  const body = await cursorPost<CursorCreateResponse>(
    apiKey,
    CURSOR_API,
    {
      name: `Resolve #${pr.number} merge conflict`,
      prompt: {
        text: [
          `Resolve the merge conflict on pull request #${pr.number}: ${pr.url}`,
          `Work on the pull request's existing head branch (${pr.headRef}).`,
          'Bring in its base branch, preserve the intended changes from both sides, run relevant checks, and push the resolution to that branch.',
          'Do not create a separate pull request.',
        ].join('\n'),
      },
      repos: [{ url: `https://github.com/${pr.repo}`, prUrl: pr.url }],
      workOnCurrentBranch: true,
      autoCreatePR: false,
    },
  )
  const agentId = body.agent?.id ?? body.id
  const runId = body.run?.id ?? body.agent?.latestRunId
  if (!agentId || !runId) throw new Error('Cursor started without returning an agent link.')
  return {
    agentId,
    runId,
    status: cursorSessionStatus(body.run?.status),
    result: null,
    branch: null,
    updatedAt: new Date().toISOString(),
  }
}

export async function refreshCursorSessions(
  sessions: { prKey: string; session: CursorSession }[],
  save: (prKey: string, session: CursorSession) => void,
): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) return
  const active = sessions.filter((item) => cursorSessionActive(item.session.status))
  await Promise.all(
    active.map(async (item) => {
      try {
        save(item.prKey, await readCursorSession(apiKey, item.session))
      } catch {
        // Keep the last status. The next refresh tries again.
      }
    }),
  )
}

async function readCursorSession(apiKey: string, session: CursorSession): Promise<CursorSession> {
  const agent = await cursorGet<CursorAgentResponse>(apiKey, `${CURSOR_API}/${encodeURIComponent(session.agentId)}`)
  const runId = agent.latestRunId || session.runId
  const run = await cursorGet<CursorRunResponse>(
    apiKey,
    `${CURSOR_API}/${encodeURIComponent(session.agentId)}/runs/${encodeURIComponent(runId)}`,
  )
  return {
    agentId: session.agentId,
    runId: run.id || runId,
    status: cursorSessionStatus(run.status),
    result: run.result ?? session.result,
    branch: cursorPushedBranch(run.git) ?? session.branch,
    updatedAt: new Date().toISOString(),
  }
}

function cursorKey(): string {
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) throw new Error('Set CURSOR_API_KEY to resolve conflicts with Cursor.')
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
    signal: AbortSignal.timeout(60_000),
  })
  return readCursor<T>(response)
}

async function cursorGet<T>(apiKey: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  return readCursor<T>(response)
}

async function readCursor<T>(response: Response): Promise<T> {
  const text = await response.text()
  const body = parseResponse(text)
  if (!response.ok) throw new Error(cursorError(response.status, body))
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
  const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message
  return detail ? `Cursor ${status}: ${detail.slice(0, 300)}` : `Cursor request failed (${status}).`
}
