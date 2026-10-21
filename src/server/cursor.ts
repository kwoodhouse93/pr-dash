import type { PullRequest } from '../shared/types.ts'

const CURSOR_API = 'https://api.cursor.com/v1/agents'

type CursorAgentResponse = {
  agent?: { id?: string }
  id?: string
}

export async function startCursorConflictResolver(pr: PullRequest): Promise<{ url: string }> {
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) throw new Error('Set CURSOR_API_KEY to resolve conflicts with Cursor.')

  const response = await fetch(CURSOR_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(60_000),
  })

  const text = await response.text()
  const body = parseResponse(text)
  if (!response.ok) throw new Error(cursorError(response.status, body))

  const id = body.agent?.id ?? body.id
  if (!id) throw new Error('Cursor started without returning an agent link.')
  return { url: `https://cursor.com/agents/${encodeURIComponent(id)}` }
}

function parseResponse(text: string): CursorAgentResponse & { message?: string; error?: { message?: string } | string } {
  try {
    return JSON.parse(text) as CursorAgentResponse & { message?: string; error?: { message?: string } | string }
  } catch {
    return {}
  }
}

function cursorError(status: number, body: { message?: string; error?: { message?: string } | string }): string {
  const detail =
    typeof body.error === 'string' ? body.error : body.error?.message ?? body.message
  return detail ? `Cursor ${status}: ${detail.slice(0, 300)}` : `Cursor request failed (${status}).`
}
