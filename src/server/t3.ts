import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { sessionNote, type AgentHealth } from '../shared/agents.ts'
import type { AgentSession, AgentSessionStatus } from '../shared/types.ts'
import { AgentUnavailable, newSession, type AgentProvider, type AgentStart } from './agent-provider.ts'

/** What `t3 thread show --json` prints, as far as this reads it. */
export type T3Thread = {
  thread?: {
    status?: string
    link?: string
    latestRunId?: string
    activeRunId?: string | null
    pendingRequestCount?: number
  }
  messages?: { role?: string; runId?: string; text?: string }[]
}

const NOT_RUNNING = /No running T3 Code server/
const NO_PROJECT = /No T3 Code project matches/
const THREAD_GONE = /is no longer available/
const REF = /^(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+$/

export const t3Provider: AgentProvider = {
  id: 't3',
  health: t3Health,
  start: startT3Thread,
  read: readT3Session,
}

async function t3Health(): Promise<AgentHealth> {
  try {
    const version = (await t3(['--version'], { timeoutMs: 10_000 })).trim()
    // Any thread id asks the server. It answering that this one is unknown shows it is up.
    await t3(['thread', 'show', 'pr-dash-health-check', '--json'], { timeoutMs: 10_000 }).catch((error) => {
      if (error instanceof AgentUnavailable) throw error
    })
    return { state: 'ready', detail: version || null }
  } catch (error) {
    if (error instanceof AgentUnavailable) return error.health
    return { state: 'unreachable', detail: messageOf(error) }
  }
}

async function startT3Thread({ pr, request, task, target }: AgentStart): Promise<AgentSession> {
  if (target.environmentId) {
    throw new AgentUnavailable('unconfigured', 'T3 Code can only start threads on this machine so far.')
  }
  if (!target.checkout) {
    throw new AgentUnavailable('unconfigured', `Set the folder T3 Code works in for ${pr.repo}, under Agents in Settings.`)
  }
  const problem = await checkoutProblem(pr.repo, target.checkout)
  if (problem) throw new AgentUnavailable('unconfigured', problem)
  if (!REF.test(pr.headRef)) throw new Error(`T3 Code cannot start from the branch name ${pr.headRef}.`)
  const checkout = expandHome(target.checkout)
  // The worktree starts from origin's copy of the branch, so bring that up to date first.
  // A branch origin does not have, as on a pull request from a fork, stops here.
  try {
    await run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`], { timeoutMs: 120_000 })
  } catch (error) {
    throw new Error(`Could not fetch ${pr.headRef} from origin in ${target.checkout}: ${messageOf(error)}`)
  }
  const started = await t3(['thread', 'start', checkout, '-', '--title', task.name, '--worktree', `origin/${pr.headRef}`, '--json'], {
    input: `${task.prompt}\n\n${worktreeNote(pr.headRef)}`,
    timeoutMs: 60_000,
  })
  const body = parseJson<{ threadId?: string; runId?: string }>(started)
  if (!body?.threadId) throw new Error('T3 Code started without returning a thread.')
  const session = newSession('t3', {
    agentId: body.threadId,
    runId: body.runId ?? body.threadId,
    kind: request.kind,
    prompt: sessionNote(request),
    status: 'creating',
    environmentId: target.environmentId,
  })
  // T3 Code accepts a thread before it has made the worktree, so this is the first sight of
  // whether it really started, and of the thread's link. The session stands either way.
  return readT3Session(session).catch(() => session)
}

/** Appended to the task. The thread is on a new local branch, not on the pull request's own. */
export function worktreeNote(headRef: string): string {
  return [
    'How to push from here:',
    `- You are in a new git worktree of this repository, on a new local branch made from origin/${headRef}.`,
    `- Commit there, then push to the pull request's branch with \`git push origin HEAD:${headRef}\`.`,
    `- If the push is rejected because ${headRef} moved, fetch it, bring your commits onto it, and push again.`,
    '- If the task rewrote history, push with `--force-with-lease`. Never use a plain `--force`.',
    '- This replaces any instruction in the repository to commit or push to another branch.',
  ].join('\n')
}

async function readT3Session(session: AgentSession): Promise<AgentSession> {
  if (session.environmentId) throw new AgentUnavailable('unconfigured', 'T3 Code can only read threads on this machine so far.')
  let shown: string
  try {
    shown = await t3(['thread', 'show', session.agentId, '--json', '--messages', '6'], { timeoutMs: 20_000 })
  } catch (error) {
    if (!(error instanceof AgentUnavailable) && THREAD_GONE.test(messageOf(error))) {
      return { ...session, status: 'expired', updatedAt: new Date().toISOString() }
    }
    throw error
  }
  const body = parseJson<T3Thread>(shown)
  if (!body?.thread) throw new Error('T3 Code returned an unreadable thread.')
  return t3Session(session, body)
}

/** The session, brought up to date from what T3 Code shows for its thread. */
export function t3Session(session: AgentSession, shown: T3Thread, now = new Date().toISOString()): AgentSession {
  const thread = shown.thread ?? {}
  const status = t3Status(thread)
  const runId = thread.latestRunId ?? session.runId
  const reply = [...(shown.messages ?? [])].reverse().find((message) => message.role === 'assistant' && (!message.runId || message.runId === runId))
  const text = reply?.text?.trim() || null
  const result =
    status === 'failed' && !text ? 'T3 Code could not run this thread. Open it in T3 Code to see why.' : status === 'creating' || status === 'running' ? session.result : (text ?? session.result)
  return {
    ...session,
    runId,
    status,
    result,
    url: thread.link ?? session.url,
    updatedAt: now,
  }
}

function t3Status(thread: NonNullable<T3Thread['thread']>): AgentSessionStatus {
  if ((thread.pendingRequestCount ?? 0) > 0) return 'waiting'
  switch (thread.status) {
    case 'preparing':
    case 'queued':
    case 'starting':
      return 'creating'
    case 'running':
      return 'running'
    case 'completed':
      return 'finished'
    case 'failed':
    case 'error':
      return 'failed'
    case 'interrupted':
    case 'cancelled':
    case 'stopped':
      return 'cancelled'
    default:
      // A status this does not know: go by whether a run is still going.
      return thread.activeRunId ? 'running' : thread.status ? 'finished' : 'running'
  }
}

/** Why T3 Code cannot work on this repository in this folder, or null when it can. */
export async function checkoutProblem(repo: string, folder: string): Promise<string | null> {
  const checkout = expandHome(folder)
  if (!path.isAbsolute(checkout)) return 'Give the full path to the folder, such as ~/code/app.'
  if (!existsSync(checkout)) return `${folder} is not a folder on this machine.`
  let origin: string
  try {
    origin = (await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })).trim()
  } catch {
    return `${folder} is not a git checkout with an origin remote.`
  }
  const found = originRepo(origin)
  if (found?.toLowerCase() !== repo.toLowerCase()) return `${folder} is a checkout of ${found ?? origin}, not ${repo}.`
  try {
    await t3(['thread', 'list', '--project', checkout, '--json'], { timeoutMs: 15_000 })
  } catch (error) {
    // A stopped T3 Code says nothing about the folder. Starting an agent reports that.
    if (error instanceof AgentUnavailable) return null
    if (NO_PROJECT.test(messageOf(error))) return `T3 Code has no project for ${folder}. Add it there, or run \`t3 project add ${folder}\`.`
    return messageOf(error)
  }
  return null
}

/** `owner/name` from a GitHub remote address, or null for anything else. */
export function originRepo(remote: string): string | null {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

export function expandHome(folder: string): string {
  const trimmed = folder.trim()
  if (trimmed === '~') return homedir()
  return trimmed.startsWith('~/') ? path.join(homedir(), trimmed.slice(2)) : trimmed
}

function t3(args: string[], options: { input?: string; timeoutMs: number }): Promise<string> {
  return run(process.env.T3_BIN || 't3', args, options).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentUnavailable('unconfigured', 'The t3 command was not found. Install it from T3 Code, or set T3_BIN to its path.')
    }
    if (NOT_RUNNING.test(messageOf(error))) throw new AgentUnavailable('unreachable', 'T3 Code is not running on this machine. Start it, then try again.')
    if ((error as { killed?: boolean }).killed) throw new AgentUnavailable('unreachable', 'T3 Code did not answer in time.')
    throw error
  })
}

function run(file: string, args: string[], options: { input?: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      const said = (stderr || stdout).trim()
      reject(Object.assign(new Error(said ? said.slice(0, 400) : error.message), { code: (error as NodeJS.ErrnoException).code, killed: error.killed }))
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input ?? '')
  })
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
