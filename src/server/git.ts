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

let current: ReturnType<typeof execFile> | null = null
let interruptible = true

export function interruptGit() {
  if (interruptible) current?.kill('SIGTERM')
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
  const header =
    token === null
      ? []
      : ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
  const prefix = cwd ? ['-C', cwd] : []
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
        if (current === child) current = null
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
    current = child
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

export async function rebaseOnto(input: {
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
  await git(
    input.mirror,
    ['fetch', '--prune', 'origin', `+refs/heads/${input.trunk}:refs/heads/${input.trunk}`, `+refs/heads/${input.branch}:refs/heads/${input.branch}`],
    input.token,
  )
  const remoteOid = (await git(input.mirror, ['rev-parse', `refs/heads/${input.branch}`], null)).toLowerCase()
  if (remoteOid !== expected) throw new GitError(`${input.branch} moved on the remote.`)
  const kind = await git(input.mirror, ['cat-file', '-t', cutoff], null).catch(() => '')
  if (kind !== 'commit') throw new GitError(`Commit ${cutoff.slice(0, 7)} is not in ${input.branch}.`)
  if (input.shouldStop?.()) throw new GitCancelled()

  const worktree = await mkdtemp(path.join(tmpdir(), 'pr-dash-rebase-'))
  try {
    await git(input.mirror, ['worktree', 'add', '--detach', worktree, input.trunk], null)
    try {
      await git(worktree, ['rebase', '--onto', input.trunk, cutoff, input.branch], null)
    } catch (error) {
      await git(worktree, ['rebase', '--abort'], null).catch(() => undefined)
      throw error
    }
    if (input.shouldStop?.()) throw new GitCancelled()
    const next = (await git(worktree, ['rev-parse', 'HEAD'], null)).toLowerCase()
    interruptible = false
    try {
      await git(
        worktree,
        ['push', 'origin', `HEAD:refs/heads/${input.branch}`, `--force-with-lease=refs/heads/${input.branch}:${expected}`],
        input.token,
      )
    } finally {
      interruptible = true
    }
    return next
  } finally {
    await git(worktree, ['rebase', '--abort'], null).catch(() => undefined)
    await git(input.mirror, ['worktree', 'remove', '--force', worktree], null).catch(() => undefined)
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
  }
}
