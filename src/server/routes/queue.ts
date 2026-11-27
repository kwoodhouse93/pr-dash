import { checkPhase, selectChecks } from '../../shared/ci.ts'
import type { PullRequest } from '../../shared/types.ts'
import { Refused } from '../errors.ts'
import { loadGithubToken } from '../github-client.ts'
import { rerunWorkflows } from '../github-pull.ts'
import { cancelEntry, enqueueDownstack, enqueuePull, moveEntry, retryEntry } from '../merge-worker.ts'
import { rebasePull } from '../rebase.ts'
import { read, required, type Routes } from './http.ts'

function collectRuns(prs: PullRequest[], mode: 'failed' | 'all'): { repo: string; runId: number }[] {
  const runs: { repo: string; runId: number }[] = []
  for (const pr of prs) {
    for (const check of selectChecks(pr.checks)) {
      if (!check.workflowRunId) continue
      if (mode === 'failed' && checkPhase(check) !== 'fail') continue
      runs.push({ repo: pr.repo, runId: check.workflowRunId })
    }
  }
  return runs
}

/** The merge queue, and the other work done on a branch: rebasing it and running its checks again. */
export const queueRoutes: Routes = (app, db) => {
  app.get('/api/merge-queue', (c) => c.json(db.queue.snapshot()))

  app.post('/api/merge-queue', async (c) => {
    const body = await read<{ key: string; scope: 'pr' | 'downstack' | 'unapproved' }>(c)
    const key = required(body.key)
    if (body.scope === 'downstack') await enqueueDownstack(db, key)
    else await enqueuePull(db, key, body.scope === 'unapproved')
    return c.json(db.queue.snapshot())
  })

  app.post('/api/merge-queue/:id/cancel', (c) => {
    cancelEntry(db, c.req.param('id'))
    return c.json(db.queue.snapshot())
  })

  app.post('/api/merge-queue/:id/retry', async (c) => {
    await retryEntry(db, c.req.param('id'))
    return c.json(db.queue.snapshot())
  })

  app.post('/api/merge-queue/:id/move', async (c) => {
    const { direction } = await read<{ direction: 'up' | 'down' }>(c)
    if (direction !== 'up' && direction !== 'down') throw new Refused('direction must be up or down.')
    moveEntry(db, c.req.param('id'), direction)
    return c.json(db.queue.snapshot())
  })

  app.post('/api/rerun', async (c) => {
    const body = await read<{ keys: string[]; mode: 'failed' | 'all' }>(c)
    const mode = body.mode === 'all' ? 'all' : 'failed'
    const keys = new Set(body.keys ?? [])
    const snap = db.snapshot()
    const prs = [...snap.pullRequests, ...snap.reviewPullRequests].filter((pr) => keys.has(pr.key))
    const runs = collectRuns(prs, mode)
    if (runs.length === 0) throw new Refused('These checks are not GitHub Actions workflows, so they cannot be rerun from here.')
    const result = await rerunWorkflows(loadGithubToken(), runs, mode)
    if (result.reran === 0) throw new Error(result.errors.join('\n') || 'Rerun failed.')
    return c.json(result)
  })

  app.post('/api/rebase', async (c) => {
    const key = required((await read<{ key: string }>(c)).key)
    return c.json(await rebasePull(db, key))
  })
}
