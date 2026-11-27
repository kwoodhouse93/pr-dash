import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

export class GitCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'GitCancelled'
  }
}

const REF = /^(?!@)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+$/
const OID = /^[0-9a-f]{40}$/

/** Git work on one mirror. Repos run side by side, so a cancel must only reach its own mirror. */
type Scope = { child: ReturnType<typeof execFile> | null; interruptible: boolean }
const scopes = new Map<string, Scope>()
const running = new AsyncLocalStorage<Scope>()

function scoped<T>(mirror: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(mirror)
  let scope = scopes.get(key)
  if (!scope) {
    scope = { child: null, interruptible: true }
    scopes.set(key, scope)
  }
  return running.run(scope, work)
}

export function interruptGit(mirror: string) {
  const scope = scopes.get(path.resolve(mirror))
  if (scope?.interruptible) scope.child?.kill('SIGTERM')
}

function assertRef(ref: string) {
  if (!REF.test(ref) || ref.startsWith('-') || ref.endsWith('.lock')) {
    throw new GitError(`Refusing to use branch name "${ref}".`)
  }
}

function assertOid(oid: string) {
  if (!OID.test(oid)) throw new GitError(`Refusing to use commit "${oid}".`)
}

function git(cwd: string | null, args: string[], token: string | null): Promise<string> {
  const header = token === null ? [] : ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
  const prefix = cwd ? ['-C', cwd] : []
  const scope = running.getStore()
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...prefix, ...header, ...args],
      {
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (scope?.child === child) scope.child = null
        if (error) {
          const killed = error.killed || /SIGTERM/.test(error.message)
          if (killed) {
            reject(new GitCancelled())
            return
          }
          const text = `${stderr || ''}`.trim().split('\n').at(-1) || error.message
          reject(new GitError(text.slice(0, 300)))
          return
        }
        resolve(String(stdout).trim())
      },
    )
    if (scope) scope.child = child
  })
}

async function ensureMirror(dir: string, remote: string, token: string | null) {
  if (existsSync(path.join(dir, 'HEAD'))) {
    await git(dir, ['remote', 'set-url', 'origin', remote], null)
    return
  }
  mkdirSync(path.dirname(dir), { recursive: true })
  await git(null, ['clone', '--bare', remote, dir], token)
}

export async function abortRebases(mirror: string) {
  if (!existsSync(path.join(mirror, 'HEAD'))) return
  const listed = await git(mirror, ['worktree', 'list', '--porcelain'], null).catch(() => '')
  const trees = listed
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((tree) => path.resolve(tree) !== path.resolve(mirror))
  for (const tree of trees) {
    await git(tree, ['rebase', '--abort'], null).catch(() => undefined)
    await git(mirror, ['worktree', 'remove', '--force', tree], null).catch(() => undefined)
    await rm(tree, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function mirrorsRoot(): string {
  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'pr-dash.sqlite')
  return path.join(path.dirname(dbPath), 'mirrors')
}

export function mirrorPath(repo: string): string {
  const slash = repo.indexOf('/')
  const owner = slash === -1 ? 'repo' : repo.slice(0, slash)
  const name = slash === -1 ? repo : repo.slice(slash + 1)
  return path.join(mirrorsRoot(), owner, `${name}.git`)
}

export async function removeMirror(repo: string): Promise<void> {
  const root = path.resolve(mirrorsRoot())
  const target = path.resolve(mirrorPath(repo))
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Refusing to delete a mirror outside the mirrors directory.')
  }
  await rm(target, { recursive: true, force: true })
}

export class AlreadyBased extends GitError {
  constructor(branch: string, base: string) {
    super(`${branch} is already based on ${base}.`)
    this.name = 'AlreadyBased'
  }
}

function refspec(ref: string): string {
  return `+refs/heads/${ref}:refs/heads/${ref}`
}

async function fetchHeads(mirror: string, token: string | null, refs: string[]) {
  await git(mirror, ['fetch', '--prune', 'origin', ...refs.map(refspec)], token)
}

/** Replay `branch` onto the latest tip of `base`, using their merge base as the cutoff. */
export function rebaseOntoTip(input: Parameters<typeof ontoTip>[0]): Promise<string> {
  return scoped(input.mirror, () => ontoTip(input))
}

async function ontoTip(input: {
  mirror: string
  remote: string
  token: string | null
  base: string
  branch: string
  expectedOid: string
  shouldStop?: () => boolean
}): Promise<string> {
  assertRef(input.base)
  assertRef(input.branch)
  const expected = input.expectedOid.toLowerCase()
  assertOid(expected)
  if (input.shouldStop?.()) throw new GitCancelled()
  await ensureMirror(input.mirror, input.remote, input.token)
  await fetchHeads(input.mirror, input.token, [input.base, input.branch])
  const remoteOid = (await git(input.mirror, ['rev-parse', `refs/heads/${input.branch}`], null)).toLowerCase()
  if (remoteOid !== expected) throw new GitError(`${input.branch} moved on the remote.`)
  const baseOid = (await git(input.mirror, ['rev-parse', `refs/heads/${input.base}`], null)).toLowerCase()
  const mergeBase = await git(input.mirror, ['merge-base', `refs/heads/${input.base}`, `refs/heads/${input.branch}`], null)
    .then((oid) => oid.toLowerCase())
    .catch(() => '')
  if (!OID.test(mergeBase)) throw new GitError(`${input.branch} has no common history with ${input.base}.`)
  if (mergeBase === baseOid) throw new AlreadyBased(input.branch, input.base)
  return replay({
    mirror: input.mirror,
    token: input.token,
    onto: input.base,
    branch: input.branch,
    cutoffOid: mergeBase,
    expectedOid: expected,
    shouldStop: input.shouldStop,
  })
}

export function rebaseOnto(input: Parameters<typeof onto>[0]): Promise<string> {
  return scoped(input.mirror, () => onto(input))
}

async function onto(input: {
  mirror: string
  remote: string
  token: string | null
  trunk: string
  branch: string
  cutoffOid: string
  expectedOid: string
  shouldStop?: () => boolean
}): Promise<string> {
  assertRef(input.trunk)
  assertRef(input.branch)
  const cutoff = input.cutoffOid.toLowerCase()
  const expected = input.expectedOid.toLowerCase()
  assertOid(cutoff)
  assertOid(expected)
  if (input.shouldStop?.()) throw new GitCancelled()
  await ensureMirror(input.mirror, input.remote, input.token)
  await fetchHeads(input.mirror, input.token, [input.trunk, input.branch])
  const remoteOid = (await git(input.mirror, ['rev-parse', `refs/heads/${input.branch}`], null)).toLowerCase()
  if (remoteOid !== expected) throw new GitError(`${input.branch} moved on the remote.`)
  const kind = await git(input.mirror, ['cat-file', '-t', cutoff], null).catch(() => '')
  if (kind !== 'commit')
    throw new GitError(`${input.branch} is not built on the latest commit (${cutoff.slice(0, 7)}) of the branch below it. Restack and push it, then retry.`)
  return replay({
    mirror: input.mirror,
    token: input.token,
    onto: input.trunk,
    branch: input.branch,
    cutoffOid: cutoff,
    expectedOid: expected,
    shouldStop: input.shouldStop,
  })
}

async function replay(input: {
  mirror: string
  token: string | null
  onto: string
  branch: string
  cutoffOid: string
  expectedOid: string
  shouldStop?: () => boolean
}): Promise<string> {
  if (input.shouldStop?.()) throw new GitCancelled()
  const worktree = await mkdtemp(path.join(tmpdir(), 'pr-dash-rebase-'))
  try {
    await git(input.mirror, ['worktree', 'add', '--detach', worktree, input.onto], null)
    try {
      await git(worktree, ['rebase', '--onto', input.onto, input.cutoffOid, input.branch], null)
    } catch (error) {
      await git(worktree, ['rebase', '--abort'], null).catch(() => undefined)
      throw error
    }
    if (input.shouldStop?.()) throw new GitCancelled()
    const next = (await git(worktree, ['rev-parse', 'HEAD'], null)).toLowerCase()
    const scope = running.getStore()
    if (scope) scope.interruptible = false
    try {
      await git(
        worktree,
        ['push', 'origin', `HEAD:refs/heads/${input.branch}`, `--force-with-lease=refs/heads/${input.branch}:${input.expectedOid}`],
        input.token,
      )
    } finally {
      if (scope) scope.interruptible = true
    }
    return next
  } finally {
    await git(worktree, ['rebase', '--abort'], null).catch(() => undefined)
    await git(input.mirror, ['worktree', 'remove', '--force', worktree], null).catch(() => undefined)
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
  }
}
