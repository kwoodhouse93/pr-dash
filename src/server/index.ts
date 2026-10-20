import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { loadEnv } from './env.ts'
import { openDatabase } from './db.ts'
import { loadGithubToken, rerunWorkflows } from './github.ts'
import { refreshSnapshot, syncStatus } from './sync.ts'
import type { PullRequest } from '../shared/types.ts'
import { checkPhase } from '../shared/ci.ts'

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

const webRoot = path.resolve('dist/web')
if (existsSync(path.join(webRoot, 'index.html'))) {
  app.use('/assets/*', serveStatic({ root: webRoot }))
  app.get('*', (c) => c.html(readFileSync(path.join(webRoot, 'index.html'), 'utf8')))
}

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed'
}
