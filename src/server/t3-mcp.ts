import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AgentUnavailable } from './agent-provider.ts'
import { databasePath } from './db.ts'
import { t3Origin } from './t3-home.ts'

/**
 * PR Dash's own sign-in to the T3 Code on this machine, and the tools it calls there.
 * The `t3` command only works on this machine. These tools also reach the environments
 * T3 Code is linked to, which is how a thread starts on another one.
 */

/** What PR Dash asks to do in T3 Code: read threads and run them. */
const SCOPE = 'orchestration:read orchestration:operate'
const NOT_CONNECTED = 'PR Dash is not connected to T3 Code. Connect it under Agents in Settings.'
const NOT_RUNNING = 'T3 Code is not running on this machine. Start it, then try again.'
/** How long an approval page may stay open before its answer is refused. */
const PENDING_MS = 15 * 60 * 1000

type Connection = { clientId: string; accessToken: string; expiresAt: string }
type Pending = { state: string; verifier: string; clientId: string; redirectUri: string; origin: string; at: number }

/** T3 Code refused a tool call, or could not carry it out. */
export class T3ToolError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'T3ToolError'
    this.code = code
  }
}

function connectionFile(): string {
  return path.join(path.dirname(databasePath()), 't3-connection.json')
}

function pendingFile(): string {
  return path.join(path.dirname(databasePath()), 't3-connect-pending.json')
}

/**
 * A sign-in that was started and not yet answered. It is kept on disk, not in memory: the user answers on
 * T3 Code's page, and the desktop app restarts this server for an update at just such a change of tab.
 */
export function readPending(file = pendingFile(), now = Date.now()): Pending | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Pending>
    const texts = [saved.state, saved.verifier, saved.clientId, saved.redirectUri, saved.origin]
    if (!texts.every((text) => typeof text === 'string') || typeof saved.at !== 'number') return null
    return now - saved.at > PENDING_MS ? null : (saved as Pending)
  } catch {
    return null
  }
}

export function savePending(started: Pending | null, file = pendingFile()): void {
  if (!started) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  // It holds the secret half of the sign-in, so only this user may read it.
  writeFileSync(file, JSON.stringify(started), { mode: 0o600 })
}

/** The saved sign-in, or null when there is none or it has run out. */
export function readConnection(file = connectionFile(), now = Date.now()): Connection | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Connection>
    if (typeof saved.clientId !== 'string' || typeof saved.accessToken !== 'string' || typeof saved.expiresAt !== 'string') return null
    return Date.parse(saved.expiresAt) > now ? { clientId: saved.clientId, accessToken: saved.accessToken, expiresAt: saved.expiresAt } : null
  } catch {
    return null
  }
}

export function saveConnection(connection: Connection | null, file = connectionFile()): void {
  if (!connection) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  // The token lets its holder run threads in T3 Code, so only this user may read it.
  writeFileSync(file, JSON.stringify(connection), { mode: 0o600 })
}

/** When the sign-in runs out, or null when PR Dash is not signed in. */
export function t3ConnectedUntil(): string | null {
  return readConnection()?.expiresAt ?? null
}

/**
 * Starts a sign-in and returns the T3 Code page where the user approves it.
 * T3 Code sends the browser to `redirectUri` with the answer, which `finishT3Connect` takes.
 */
export async function beginT3Connect(redirectUri: string): Promise<string> {
  const origin = t3Origin()
  if (!origin) throw new AgentUnavailable('unreachable', NOT_RUNNING)
  const registered = await send(`${origin}/oauth/mcp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'PR Dash',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const clientId = ((await registered.json().catch(() => null)) as { client_id?: unknown } | null)?.client_id
  if (!registered.ok || typeof clientId !== 'string') throw new Error('T3 Code would not register PR Dash as a client.')
  const verifier = randomBytes(32).toString('base64url')
  const pending: Pending = { state: randomBytes(16).toString('base64url'), verifier, clientId, redirectUri, origin, at: Date.now() }
  savePending(pending)
  const url = new URL(`${origin}/oauth/mcp/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: pending.state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${origin}/mcp`,
  }).toString()
  return url.toString()
}

/** Trades the code T3 Code sent back for a token and saves it. `state` proves the answer is to the sign-in started here. */
export async function finishT3Connect(code: string, state: string): Promise<void> {
  const started = readPending()
  if (!started || started.state !== state) throw new Error('That sign-in was not started here, or took too long. Start it again from Settings.')
  // The code works once, so the sign-in it answers is spent whether or not T3 Code takes it.
  savePending(null)
  const traded = await send(`${started.origin}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: started.redirectUri,
      client_id: started.clientId,
      code_verifier: started.verifier,
      resource: `${started.origin}/mcp`,
    }),
  })
  const body = (await traded.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error_description?: unknown } | null
  if (!traded.ok || typeof body?.access_token !== 'string') {
    throw new Error(typeof body?.error_description === 'string' ? body.error_description : 'T3 Code did not give PR Dash a token.')
  }
  const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 60 * 60
  saveConnection({ clientId: started.clientId, accessToken: body.access_token, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() })
}

/** Forgets the sign-in, and asks T3 Code to end it when it is running. */
export async function disconnectT3(): Promise<void> {
  const connection = readConnection()
  saveConnection(null)
  const origin = t3Origin()
  if (!connection || !origin) return
  await send(`${origin}/oauth/mcp/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: connection.accessToken, client_id: connection.clientId }),
  }).catch(() => undefined)
}

type Rpc = { result?: { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }

/**
 * Calls one of T3 Code's tools and returns what it answered.
 * Throws `AgentUnavailable` when PR Dash is not signed in or T3 Code is not running, and `T3ToolError` when the tool refused.
 */
export async function t3Tool<T>(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  const origin = t3Origin()
  if (!origin) throw new AgentUnavailable('unreachable', NOT_RUNNING)
  const connection = readConnection()
  if (!connection) throw new AgentUnavailable('unconfigured', NOT_CONNECTED)
  const headers: Record<string, string> = {
    authorization: `Bearer ${connection.accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  let id = 0
  const rpc = async (method: string, params: unknown): Promise<Rpc> => {
    const notice = method.startsWith('notifications/')
    const response = await send(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notice ? {} : { id: ++id }) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401) {
      // T3 Code no longer takes this token: it was revoked there, or T3 Code was set up afresh.
      saveConnection(null)
      throw new AgentUnavailable('unconfigured', NOT_CONNECTED)
    }
    const session = response.headers.get('mcp-session-id')
    if (session) headers['mcp-session-id'] = session
    const text = await response.text()
    if (notice) return {}
    const parsed = parseRpc(text)
    if (!parsed) throw new Error(`T3 Code answered ${method} with something unreadable.`)
    if (parsed.error) throw new T3ToolError(parsed.error.message ?? `T3 Code refused ${method}.`, null)
    return parsed
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pr-dash', version: '1' } })
  await rpc('notifications/initialized', {})
  const { result } = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.find((part) => part.type === 'text')?.text ?? ''
  if (result?.isError) {
    const failure = parseJson<{ code?: unknown; message?: unknown }>(text)
    throw new T3ToolError(
      typeof failure?.message === 'string' ? failure.message : text || `T3 Code could not run ${name}.`,
      typeof failure?.code === 'string' ? failure.code : null,
    )
  }
  const answer = result?.structuredContent ?? parseJson<unknown>(text)
  if (answer == null) throw new Error(`T3 Code answered ${name} with nothing.`)
  return answer as T
}

/** A reply comes as plain JSON, or as an event stream whose last `data:` line is the JSON. */
export function parseRpc(text: string): Rpc | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return parseJson<Rpc>(trimmed)
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .pop()
  return data ? parseJson<Rpc>(data) : null
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(30_000), ...init })
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') throw new AgentUnavailable('unreachable', 'T3 Code did not answer in time.')
    throw new AgentUnavailable('unreachable', NOT_RUNNING)
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
