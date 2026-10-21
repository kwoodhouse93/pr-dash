import { buildStacks, restackChain } from '../shared/stacks.ts'
import type { PullRequest, Snapshot } from '../shared/types.ts'
import type { DashboardDb } from './db.ts'
import { AlreadyBased, mirrorPath, rebaseOnto, rebaseOntoTip } from './git.ts'
import { fetchLivePull, loadGithubToken } from './github.ts'

export class RebaseRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RebaseRejected'
  }
}

export async function rebasePull(db: DashboardDb, key: string): Promise<Snapshot> {
  const snap = db.snapshot()
  const list = snap.pullRequests.some((pr) => pr.key === key)
    ? snap.pullRequests
    : snap.reviewPullRequests.some((pr) => pr.key === key)
      ? snap.reviewPullRequests
      : null
  const pr = list?.find((item) => item.key === key)
  if (!list || !pr) throw new RebaseRejected('That pull request is no longer in this list.')
  if (!pr.behind) throw new RebaseRejected(`#${pr.number} is already up to date with ${pr.baseRef}.`)

  const ordered = buildStacks(list).find((stack) => stack.prs.some((item) => item.key === key))?.prs ?? []
  const stack = restackChain(ordered, key)
  if (!stack) throw new RebaseRejected('That pull request is no longer in this list.')
  if (db.queue.repoActive(pr.repo)) throw new RebaseRejected('A merge is in progress for this repo.')
  for (const item of stack) {
    if (db.queue.blocksKey(item.key)) throw new RebaseRejected(`#${item.number} is in the merge queue.`)
  }

  const token = loadGithubToken()
  const live = new Map<string, Awaited<ReturnType<typeof fetchLivePull>>>()
  for (const item of stack) {
    const next = await fetchLivePull(token, item.repo, item.number, item.requiredCheckNames ?? [])
    if (next.state !== 'OPEN') throw new RebaseRejected(`#${item.number} is ${next.state.toLowerCase()}.`)
    if (next.headRef !== item.headRef || next.baseRef !== item.baseRef) {
      throw new RebaseRejected('The stack changed. Refresh and try again.')
    }
    live.set(item.key, next)
  }

  const root = stack[0]!
  const rootLive = live.get(root.key)!
  if (rootLive.mergeable === 'CONFLICTING' || rootLive.mergeStateStatus === 'DIRTY') {
    throw new RebaseRejected(`#${root.number} has a merge conflict.`)
  }
  if (rootLive.mergeStateStatus !== 'BEHIND') {
    throw new RebaseRejected(`#${root.number} is already up to date with ${rootLive.baseRef}.`)
  }

  const mirror = mirrorPath(pr.repo)
  const remote = `https://github.com/${pr.repo}.git`
  const rewritten: PullRequest[] = []
  let previous: { branch: string; oldOid: string } | null = null
  for (const item of stack) {
    const current = live.get(item.key)!
    const onto = previous?.branch ?? item.baseRef
    try {
      if (!previous) {
        await rebaseOntoTip({
          mirror,
          remote,
          token,
          base: item.baseRef,
          branch: item.headRef,
          expectedOid: current.headOid,
        })
      } else {
        await rebaseOnto({
          mirror,
          remote,
          token,
          trunk: previous.branch,
          branch: item.headRef,
          cutoffOid: previous.oldOid,
          expectedOid: current.headOid,
        })
      }
    } catch (error) {
      if (rewritten.length === 0) {
        if (error instanceof AlreadyBased) {
          throw new RebaseRejected(`#${item.number} is already up to date with ${onto}.`)
        }
        throw error
      }
      const detail = error instanceof Error ? error.message : 'Rebase failed'
      const done = rewritten.map((pulled) => `#${pulled.number}`).join(', ')
      throw new Error(`Rebased ${done}, then #${item.number} failed: ${detail}`)
    }
    rewritten.push(item)
    previous = { branch: item.headRef, oldOid: current.headOid }
  }

  return markCurrent(db, new Set(rewritten.map((item) => item.key)))
}

function markCurrent(db: DashboardDb, keys: Set<string>): Snapshot {
  const snap = db.snapshot()
  const patch = (pr: PullRequest): PullRequest => (keys.has(pr.key) ? { ...pr, behind: false } : pr)
  return db.saveSnapshot({
    viewer: snap.viewer ?? '',
    syncedAt: snap.syncedAt ?? new Date().toISOString(),
    pullRequests: snap.pullRequests.map(patch),
    reviewPullRequests: snap.reviewPullRequests.map(patch),
    linearConfigured: snap.linearConfigured,
    warning: snap.warning,
  })
}
