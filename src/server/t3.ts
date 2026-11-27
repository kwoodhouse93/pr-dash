import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { environmentName, sessionNote, type AgentHealth, type T3Environment } from '../shared/agents.ts'
import type { AgentSession, AgentSessionStatus } from '../shared/types.ts'
import { AgentUnavailable, newSession, type AgentProvider, type AgentStart } from './agent-provider.ts'
import { T3_HOME, t3Origin } from './t3-home.ts'
import { T3ToolError, t3ConnectedUntil, t3Tool } from './t3-mcp.ts'
import { readRemotes, saveRemote } from './t3-remotes.ts'

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

async function startT3Thread(input: AgentStart): Promise<AgentSession> {
  const { pr, request, task, target } = input
  if (target.environmentId) return startRemoteThread(input, target.environmentId)
  if (!target.checkout) {
    throw new AgentUnavailable(
      'unconfigured',
      `T3 Code has no project for ${pr.repo}. Add its folder as a project in T3 Code, or set a folder under Agents in Settings.`,
    )
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
  if (session.environmentId) return readRemoteSession(session, session.environmentId)
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
    status === 'failed' && !text
      ? 'T3 Code could not run this thread. Open it in T3 Code to see why.'
      : status === 'creating' || status === 'running'
        ? session.result
        : (text ?? session.result)
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
    case 'waiting':
      return 'waiting'
    case 'completed':
    case 'idle':
      return 'finished'
    case 'failed':
    case 'error':
      return 'failed'
    case 'interrupted':
    case 'cancelled':
    case 'stopped':
    case 'rolled_back':
      return 'cancelled'
    default:
      // A status this does not know: go by whether a run is still going.
      return thread.activeRunId ? 'running' : thread.status ? 'finished' : 'running'
  }
}

type Link = { environmentId?: unknown; label?: unknown; urls?: unknown; status?: unknown; lastError?: unknown }

function linked(items: unknown[]): T3Environment[] {
  const remotes = readRemotes()
  return items.flatMap((item) => {
    const link = item as Link
    if (typeof link.environmentId !== 'string') return []
    const reachable = link.status === 'reachable'
    const said = typeof link.lastError === 'string' && link.lastError ? link.lastError : typeof link.status === 'string' ? link.status : null
    return [
      {
        id: link.environmentId,
        label: typeof link.label === 'string' && link.label ? link.label : link.environmentId,
        host: hostOf(Array.isArray(link.urls) ? link.urls[0] : null) ?? hostOf(remotes[link.environmentId]?.origin),
        reachable,
        detail: reachable ? null : link.status === 'expired' ? 'Its link has run out. Link it again with `t3 environment link`.' : said,
        ssh: remotes[link.environmentId]?.ssh ?? null,
      },
    ]
  })
}

/**
 * Each environment the T3 Code on this machine is linked to, and whether it answers now. Throws when T3 Code
 * cannot be asked: an empty list means it is linked to none, which is not the same thing.
 */
export async function t3Environments(): Promise<T3Environment[]> {
  // Signed in, PR Dash asks T3 Code's server, as it does to start a thread there. The command is the way without a sign-in.
  if (t3ConnectedUntil()) {
    const asked = await t3Tool<{ links?: unknown }>('t3_environment_links', {}, 20_000).catch(() => null)
    if (Array.isArray(asked?.links)) return linked(asked.links)
  }
  const listed = parseJson<unknown>(await t3(['environment', 'list', '--json'], { timeoutMs: 20_000 }))
  if (!Array.isArray(listed)) throw new Error('T3 Code listed its environments in a form PR Dash cannot read.')
  return linked(listed)
}

function hostOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? new URL(url).host : null
  } catch {
    return null
  }
}

type RemoteProject = {
  id?: unknown
  title?: unknown
  workspaceRoot?: unknown
  archivedAt?: unknown
  deletedAt?: unknown
  repositoryIdentity?: { provider?: unknown; owner?: unknown; name?: unknown } | null
}

/** The T3 Code project for each GitHub repository in another environment, as that environment lists them. Keys are lower case. */
export async function t3RemoteProjects(environmentId: string): Promise<Map<string, T3Project>> {
  const found = new Map<string, T3Project>()
  let cursor: number | null = null
  // T3 Code lists a page at a time. Nobody has this many projects, so the limit only stops a loop.
  for (let page = 0; page < 20; page += 1) {
    const listed: { projects?: RemoteProject[]; nextCursor?: number | null } = await t3Tool('t3_project_list', {
      environmentId,
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    })
    for (const project of listed.projects ?? []) {
      const repo = project.repositoryIdentity
      if (typeof project.id !== 'string' || typeof project.workspaceRoot !== 'string' || project.archivedAt || project.deletedAt) continue
      if (repo?.provider !== 'github' || typeof repo.owner !== 'string' || typeof repo.name !== 'string') continue
      const key = `${repo.owner}/${repo.name}`.toLowerCase()
      if (!found.has(key)) found.set(key, { id: project.id, title: typeof project.title === 'string' ? project.title : repo.name, root: project.workspaceRoot })
    }
    if (typeof listed.nextCursor !== 'number') break
    cursor = listed.nextCursor
  }
  return found
}

/** The environment as linked now. Throws `AgentUnavailable` when it is not linked or not answering. */
async function reachableEnvironment(environmentId: string): Promise<T3Environment> {
  const environment = (await t3Environments()).find((item) => item.id === environmentId)
  if (!environment)
    throw new AgentUnavailable(
      'unconfigured',
      'T3 Code is no longer linked to the environment chosen for this repository. Pick another under Agents in Settings.',
    )
  if (!environment.reachable) {
    throw new AgentUnavailable('unreachable', `${environmentName(environment)} is not answering${environment.detail ? `: ${environment.detail}` : '.'}`)
  }
  return environment
}

/**
 * Where a thread on another environment opens. Once PR Dash knows where that machine's T3 Code answers, it is the
 * thread's page there, which a browser paired with it shows. Until then T3 Code's own app takes it from the link.
 */
export function remoteThreadLink(environmentId: string, threadId: string, origin: string | null = null): string {
  return `${origin ?? 'https://app.t3.codes'}/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
}

function remoteOrigin(environmentId: string): string | null {
  return readRemotes()[environmentId]?.origin ?? null
}

const SSH_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/
const TAILSCALE_CHECK = /https:\/\/login\.tailscale\.com\/\S+/

/**
 * A link that pairs whichever browser opens it with the T3 Code on another machine, so that browser can show the
 * threads started there. Only that machine can make one, so its `t3` command is run over SSH, as `login`.
 * The login and where that T3 Code answers are kept, for the next pairing and for the threads' links.
 */
export async function t3RemotePairLink(environmentId: string, login: string): Promise<{ pairUrl: string; origin: string }> {
  if (!SSH_LOGIN.test(login)) throw new AgentUnavailable('unconfigured', 'Give the SSH login as user@host, such as dev@devbox.')
  const environment = (await t3Environments()).find((item) => item.id === environmentId)
  if (!environment) throw new AgentUnavailable('unconfigured', 'T3 Code is not linked to that environment.')
  // T3 Code says where a linked environment answers when it is asked by its command. Failing that, it is the host signed in to.
  const origin = remoteOrigin(environmentId) ?? `https://${environment.host ?? login.slice(login.indexOf('@') + 1)}`
  const command = [
    // A login without a terminal has a short PATH. These are where T3 Code puts its command.
    'PATH="$HOME/.local/bin:$HOME/.t3/bin:$PATH"',
    't3 auth pairing create --json --ttl 5m',
    "--label 'PR Dash'",
    `--base-url '${origin}'`,
    ...PAIR_SCOPES.map((scope) => `--scope ${scope}`),
  ].join(' ')
  let made: string
  try {
    made = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', login, command], { timeoutMs: 20_000 })
  } catch (error) {
    // Tailscale holds an SSH login until it is approved in a browser, and says where.
    const check = TAILSCALE_CHECK.exec(messageOf(error))?.[0]
    if (check) throw new AgentUnavailable('unconfigured', `Tailscale wants this SSH login approved first. Open ${check} and then pair again.`)
    throw new Error(`Could not run t3 on ${login}: ${messageOf(error)}`)
  }
  // SSH may print a notice before what the command printed.
  const pairUrl = parseJson<{ pairUrl?: string }>(made.slice(made.indexOf('{')))?.pairUrl
  if (!pairUrl?.startsWith(`${origin}/`)) throw new Error(`T3 Code on ${login} did not return a pairing link.`)
  saveRemote(environmentId, { origin, ssh: login })
  return { pairUrl, origin }
}

async function startRemoteThread({ pr, request, task }: AgentStart, environmentId: string): Promise<AgentSession> {
  if (!REF.test(pr.headRef)) throw new Error(`T3 Code cannot start from the branch name ${pr.headRef}.`)
  const environment = await reachableEnvironment(environmentId)
  const project = (await t3RemoteProjects(environmentId)).get(pr.repo.toLowerCase())
  if (!project) {
    throw new AgentUnavailable(
      'unconfigured',
      `${environmentName(environment)} has no T3 Code project for ${pr.repo}. Add one there, or set this repository to run on this machine under Agents in Settings.`,
    )
  }
  // That environment fetches the branch itself and makes the worktree from origin's copy of it.
  const started = await t3Tool<{ threadId?: string; runId?: string | null; status?: string | null }>('t3_thread_launch', {
    environmentId,
    projectId: project.id,
    title: task.name,
    workspaceStrategy: { type: 'worktree', baseRef: `origin/${pr.headRef}`, startFromOrigin: true },
    message: `${task.prompt}\n\n${worktreeNote(pr.headRef)}`,
    // Not sent again on failure: the user starts another, and two threads on one branch would fight.
    clientRequestId: randomUUID(),
  })
  if (!started.threadId) throw new Error('T3 Code started without returning a thread.')
  return newSession('t3', {
    agentId: started.threadId,
    runId: started.runId ?? started.threadId,
    kind: request.kind,
    prompt: sessionNote(request),
    status: started.status ? t3Status({ status: started.status }) : 'creating',
    environmentId,
    url: remoteThreadLink(environmentId, started.threadId, remoteOrigin(environmentId)),
  })
}

type RemoteThread = {
  thread?: { status?: string; latestRunId?: string | null; activeRunId?: string | null; pendingRequestCount?: number }
  /** Newest first. */
  items?: { type?: string; runId?: string | null; text?: string | null }[]
}

/** What another environment shows for a thread, in the shape the `t3` command prints for one here. */
export function remoteThread(shown: RemoteThread): T3Thread {
  const thread = shown.thread ?? {}
  return {
    thread: {
      status: thread.status,
      latestRunId: thread.latestRunId ?? undefined,
      activeRunId: thread.activeRunId,
      pendingRequestCount: thread.pendingRequestCount,
    },
    messages: [...(shown.items ?? [])]
      .reverse()
      .filter((item) => item.type === 'assistant_message')
      .map((item) => ({ role: 'assistant', runId: item.runId ?? undefined, text: item.text ?? undefined })),
  }
}

const REMOTE_THREAD_GONE = /not found|no longer|does not exist|unknown thread/i

async function readRemoteSession(session: AgentSession, environmentId: string): Promise<AgentSession> {
  try {
    const shown = await t3Tool<RemoteThread>('t3_thread_read', { environmentId, threadId: session.agentId, limit: 6 })
    if (!shown.thread) throw new Error('T3 Code returned an unreadable thread.')
    // The link follows what PR Dash has since learnt of where that machine's T3 Code answers.
    return t3Session({ ...session, url: remoteThreadLink(environmentId, session.agentId, remoteOrigin(environmentId)) }, remoteThread(shown))
  } catch (error) {
    if (!(error instanceof T3ToolError)) throw error
    // The tool fails the same way for a thread that is gone and a machine that is off, so ask which.
    await reachableEnvironment(environmentId)
    if (REMOTE_THREAD_GONE.test(error.message)) return { ...session, status: 'expired', updatedAt: new Date().toISOString() }
    throw error
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

/** What a browser paired from here may do in T3 Code: read threads and take part in them. Nothing wider. */
const PAIR_SCOPES = ['orchestration:read', 'orchestration:operate']

/**
 * A link that pairs whichever browser opens it with the T3 Code on this machine, so that
 * browser can show T3 Code's threads. It works once, and for five minutes.
 */
export async function t3PairLink(): Promise<{ pairUrl: string; origin: string }> {
  const origin = t3Origin()
  if (!origin) throw new AgentUnavailable('unreachable', 'T3 Code is not running on this machine. Start it, then try again.')
  const made = await t3(
    ['auth', 'pairing', 'create', '--json', '--ttl', '5m', '--label', 'PR Dash', '--base-url', origin, ...PAIR_SCOPES.flatMap((scope) => ['--scope', scope])],
    { timeoutMs: 15_000 },
  )
  const pairUrl = parseJson<{ pairUrl?: string }>(made)?.pairUrl
  if (!pairUrl) throw new Error('T3 Code did not return a pairing link.')
  return { pairUrl, origin }
}

export type T3Project = { id: string; title: string; root: string }

/**
 * The projects T3 Code has on this machine, most recently used first. They come from
 * T3 Code's own state file, since its command has no way to list them. That file can
 * change shape between versions, so anything unexpected reads as no projects, and a
 * folder set by hand still works.
 */
export function t3Projects(home = T3_HOME()): T3Project[] {
  const file = path.join(home, 'userdata', 'statev2.sqlite')
  if (!existsSync(file)) return []
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db
      .prepare('SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC')
      .all() as { project_id: unknown; title: unknown; workspace_root: unknown }[]
    return rows.flatMap((row) =>
      typeof row.project_id === 'string' && typeof row.workspace_root === 'string' && path.isAbsolute(row.workspace_root)
        ? [{ id: row.project_id, title: typeof row.title === 'string' ? row.title : path.basename(row.workspace_root), root: row.workspace_root }]
        : [],
    )
  } catch {
    return []
  } finally {
    db?.close()
  }
}

/** The T3 Code project for each repository, by the GitHub repository its folder is a checkout of. Keys are lower case. */
export async function t3ProjectsByRepo(projects = t3Projects()): Promise<Map<string, T3Project>> {
  const found = new Map<string, T3Project>()
  const repos = await Promise.all(
    projects.map(async (project) => {
      if (!existsSync(project.root)) return null
      const origin = await run('git', ['-C', project.root, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).catch(() => '')
      return originRepo(origin)
    }),
  )
  projects.forEach((project, index) => {
    const repo = repos[index]?.toLowerCase()
    if (repo && !found.has(repo)) found.set(repo, project)
  })
  return found
}

/** A folder as the user would write it, with their home folder as `~`. */
export function shortFolder(folder: string): string {
  const home = homedir()
  return folder === home ? '~' : folder.startsWith(`${home}${path.sep}`) ? `~${folder.slice(home.length)}` : folder
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
