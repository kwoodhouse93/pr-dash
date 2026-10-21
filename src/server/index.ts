import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { loadEnv } from './env.ts'
import { openDatabase } from './db.ts'
import { loadGithubToken, rerunWorkflows, squashMergePullRequest } from './github.ts'
import {
  cancelEntry,
  enqueueDownstack,
  enqueuePull,
  MergeRejected,
  moveEntry,
  startMergeWorker,
} from './merge-worker.ts'
import { listStatuses, listUsers, updateLinearIssue } from './linear.ts'
import { canSquashMerge } from '../shared/merge.ts'
import { markMerged, refreshSnapshot, syncStatus } from './sync.ts'
import type { PullRequest } from '../shared/types.ts'
import { checkPhase } from '../shared/ci.ts'
import { startCursorConflictResolver } from './cursor.ts'

loadEnv()

const db = openDatabase()
const app = new Hono()

app.get('/api/snapshot', (c) => c.json(db.snapshot()))

app.get('/api/status', (c) => c.json(syncStatus))

app.post('/api/refresh', async (c) => {
  try {
    return c.json(await refreshSnapshot(db))
  } catch (error) {
    return c.json({ error: messageOf(error) }, 500)
  }
})

app.post('/api/initiatives', async (c) => {
  try {
    const body = await c.req.json<{ name?: string }>()
    db.createInitiative(body.name ?? '')
    return c.json(db.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, error instanceof Error && error.name === 'DuplicateInitiative' ? 409 : 400)
  }
})

app.patch('/api/initiatives/:id', async (c) => {
  try {
    const body = await c.req.json<{ name?: string }>()
    db.renameInitiative(c.req.param('id'), body.name ?? '')
    return c.json(db.snapshot())
  } catch (error) {
    const status = error instanceof Error && error.name === 'DuplicateInitiative' ? 409 : 400
    return c.json({ error: messageOf(error) }, status)
  }
})

app.delete('/api/initiatives/:id', (c) => {
  db.deleteInitiative(c.req.param('id'))
  return c.json(db.snapshot())
})

app.post('/api/assignments', async (c) => {
  try {
    const body = await c.req.json<{ initiativeId?: string; prKeys?: string[]; action?: 'add' | 'remove' }>()
    if (!body.initiativeId || !body.prKeys?.length || (body.action !== 'add' && body.action !== 'remove')) {
      return c.json({ error: 'initiativeId, prKeys, and action are required.' }, 400)
    }
    db.setAssignments(body.initiativeId, body.prKeys, body.action)
    return c.json(db.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, 400)
  }
})

app.get('/api/linear/statuses', async (c) => {
  const token = linearToken()
  if (!token) return c.json({ error: 'Set LINEAR_API_KEY to update Linear.' }, 400)
  const teamId = c.req.query('teamId') || undefined
  const issue = c.req.query('issue') || undefined
  if (!teamId && !issue) return c.json({ error: 'A Linear team or issue is required.' }, 400)
  try {
    return c.json({ statuses: await listStatuses(token, { teamId, issue }) })
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.get('/api/linear/users', async (c) => {
  const token = linearToken()
  if (!token) return c.json({ error: 'Set LINEAR_API_KEY to update Linear.' }, 400)
  try {
    return c.json({ users: await listUsers(token) })
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.post('/api/linear/issues/:identifier', async (c) => {
  const token = linearToken()
  if (!token) return c.json({ error: 'Set LINEAR_API_KEY to update Linear.' }, 400)
  try {
    const body = await c.req.json<{ statusId?: string; assigneeId?: string | null }>()
    const hasStatus = typeof body.statusId === 'string' && body.statusId.length > 0
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assigneeId')
    if (!hasStatus && !hasAssignee) return c.json({ error: 'statusId or assigneeId is required.' }, 400)
    if (hasAssignee && body.assigneeId !== null && typeof body.assigneeId !== 'string') {
      return c.json({ error: 'assigneeId must be a user id or null.' }, 400)
    }
    const updated = await updateLinearIssue(token, c.req.param('identifier'), {
      ...(hasStatus ? { statusId: body.statusId } : {}),
      ...(hasAssignee ? { assigneeId: body.assigneeId ?? null } : {}),
    })
    return c.json(db.updateLinearIssue(updated.identifier, updated))
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.post('/api/merge', async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>()
    const key = body.key ?? ''
    const snap = db.snapshot()
    const pr = snap.pullRequests.find((item) => item.key === key)
    if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
    if (db.queue.repoActive(pr.repo)) {
      return c.json({ error: 'A merge is in progress for this repo. Queue this pull request instead.' }, 409)
    }
    if (db.queue.blocksKey(pr.key)) {
      return c.json({ error: 'This pull request is already in the merge queue.' }, 409)
    }
    if (!canSquashMerge(pr)) {
      return c.json({ error: 'This pull request is not ready to squash into the default branch.' }, 409)
    }
    await squashMergePullRequest(loadGithubToken(), pr.repo, pr.number)
    markMerged(pr.key)
    return c.json(
      db.saveSnapshot({
        viewer: snap.viewer ?? '',
        syncedAt: snap.syncedAt ?? new Date().toISOString(),
        pullRequests: snap.pullRequests.filter((item) => item.key !== pr.key),
        linearConfigured: snap.linearConfigured,
        warning: snap.warning,
      }),
    )
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.get('/api/merge-queue', (c) => c.json(db.queue.snapshot()))

app.post('/api/merge-queue', async (c) => {
  try {
    const body = await c.req.json<{ key?: string; scope?: 'pr' | 'downstack' }>()
    const key = body.key ?? ''
    if (!key) return c.json({ error: 'A pull request is required.' }, 400)
    if (body.scope === 'downstack') await enqueueDownstack(db, key)
    else await enqueuePull(db, key)
    return c.json(db.queue.snapshot())
  } catch (error) {
    const status = error instanceof MergeRejected ? 409 : 502
    return c.json({ error: messageOf(error) }, status)
  }
})

app.post('/api/merge-queue/:id/cancel', (c) => {
  try {
    cancelEntry(db, c.req.param('id'))
    return c.json(db.queue.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, 400)
  }
})

app.post('/api/merge-queue/:id/move', async (c) => {
  try {
    const body = await c.req.json<{ direction?: 'up' | 'down' }>()
    if (body.direction !== 'up' && body.direction !== 'down') {
      return c.json({ error: 'direction must be up or down.' }, 400)
    }
    moveEntry(db, c.req.param('id'), body.direction)
    return c.json(db.queue.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, 400)
  }
})

app.post('/api/rerun', async (c) => {
  try {
    const body = await c.req.json<{ keys?: string[]; mode?: 'failed' | 'all' }>()
    const mode = body.mode === 'all' ? 'all' : 'failed'
    const keys = new Set(body.keys ?? [])
    const prs = db.snapshot().pullRequests.filter((pr) => keys.has(pr.key))
    const runs = collectRuns(prs, mode)
    if (runs.length === 0) {
      return c.json(
        { error: 'These checks are not GitHub Actions workflows, so they cannot be rerun from here.' },
        400,
      )
    }
    const result = await rerunWorkflows(loadGithubToken(), runs, mode)
    if (result.reran === 0) return c.json({ error: result.errors.join('\n') || 'Rerun failed.' }, 502)
    return c.json(result)
  } catch (error) {
    return c.json({ error: messageOf(error) }, 500)
  }
})

app.post('/api/conflicts/:key/cursor', async (c) => {
  const pr = db.snapshot().pullRequests.find((item) => item.key === c.req.param('key'))
  if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
  if (!pr.conflict) return c.json({ error: 'That pull request no longer has a merge conflict.' }, 409)
  try {
    const session = await startCursorConflictResolver(pr)
    db.saveCursorSession(pr.key, session)
    return c.json(db.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

const webRoot = path.resolve('dist/web')
if (existsSync(path.join(webRoot, 'index.html'))) {
  app.use('/assets/*', serveStatic({ root: webRoot }))
  app.get('*', (c) => c.html(readFileSync(path.join(webRoot, 'index.html'), 'utf8')))
}

startMergeWorker(db)

const port = Number(process.env.PORT ?? 4317)
const hostname = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`pr-dash API on http://${hostname}:${port}`)
})

function collectRuns(prs: PullRequest[], mode: 'failed' | 'all'): { repo: string; runId: number }[] {
  const runs: { repo: string; runId: number }[] = []
  for (const pr of prs) {
    for (const check of pr.checks) {
      if (!check.workflowRunId) continue
      if (mode === 'failed' && checkPhase(check) !== 'fail') continue
      runs.push({ repo: pr.repo, runId: check.workflowRunId })
    }
  }
  return runs
}

function linearToken(): string | null {
  const token = process.env.LINEAR_API_KEY
  return token && token.length > 0 ? token : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed'
}
