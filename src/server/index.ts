import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { loadEnv } from './env.ts'
import { openDatabase } from './db.ts'
import {
  fetchPullFeedback,
  loadGithubToken,
  payloadFor,
  replyToPullNote,
  replyToReviewThread,
  repositoryVisible,
  rerunWorkflows,
  setReviewThreadResolved,
  squashMergePullRequest,
  markPullReadyForReview,
} from './github.ts'
import { removeMirror } from './git.ts'
import { parseRepoName } from '../shared/repos.ts'
import { repoCatalog } from './repos.ts'
import {
  cancelEntry,
  enqueueDownstack,
  enqueuePull,
  MergeRejected,
  moveEntry,
  setMergeWhenReady,
  startMergeWorker,
} from './merge-worker.ts'
import { isLinearIdentifier } from '../shared/linear.ts'
import { linkGitHubPullRequest, listStatuses, listUsers, searchLinearIssues, updateLinearIssue } from './linear.ts'
import type { FeedbackDetail } from '../shared/feedback.ts'
import { canSquashMerge } from '../shared/merge.ts'
import { cancelQueuedSync, describeSync, enqueueSync, markMerged, loadThreadFeedback, noteListFocus, refreshPull, refreshSnapshot, startBackgroundSync, SyncCancelled } from './sync.ts'
import type { PullRequest, Snapshot } from '../shared/types.ts'
import { checkPhase, selectChecks } from '../shared/ci.ts'
import { agentBlocker, parseAgentRequest } from '../shared/agents.ts'
import { startCursorAgent } from './cursor.ts'
import { rebasePull, RebaseRejected } from './rebase.ts'

loadEnv()

const db = openDatabase()
const app = new Hono()

app.get('/api/snapshot', (c) => {
  const focus = c.req.query('focus')
  if (focus === 'mine' || focus === 'review') noteListFocus(focus)
  return c.json(db.snapshot())
})

app.get('/api/status', (c) => c.json(describeSync(db)))

app.get('/api/repos', async (c) => {
  try {
    return c.json(await repoCatalog(db))
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.post('/api/repos', async (c) => {
  try {
    const body = await c.req.json<{ repo?: string }>()
    const repo = parseRepoName(body.repo ?? '')
    if (!db.watchedRepos().includes(repo)) {
      const visible = await repositoryVisible(loadGithubToken(), repo)
      if (!visible) return c.json({ error: `GitHub did not return ${repo}. Check the name and that this token can see it.` }, 404)
      db.watchRepo(repo)
    }
    return c.json(db.snapshot())
  } catch (error) {
    return c.json({ error: messageOf(error) }, 400)
  }
})

app.post('/api/repos/remove', async (c) => {
  try {
    const body = await c.req.json<{ repo?: string }>()
    const repo = parseRepoName(body.repo ?? '')
    db.forgetRepo(repo)
    await removeMirror(repo)
    return c.json(db.snapshot())
  } catch (error) {
    const status = error instanceof Error && error.name === 'RepoBusy' ? 409 : 400
    return c.json({ error: messageOf(error) }, status)
  }
})

app.post('/api/sync', async (c) => {
  const body = await c.req.json<{ kind?: string; focus?: string }>().catch(() => ({ kind: undefined, focus: undefined }))
  if (body.kind !== 'full' && body.kind !== 'rules') return c.json({ error: 'Choose a full sync or a ruleset sync.' }, 400)
  const focus = body.focus === 'review' ? 'review' : 'mine'
  noteListFocus(focus)
  return c.json(enqueueSync(db, body.kind, focus))
})

app.post('/api/sync/:id/cancel', (c) => c.json(cancelQueuedSync(db, c.req.param('id'))))

app.post('/api/refresh', async (c) => {
  try {
    const body = await c.req
      .json<{ focus?: string; full?: boolean; interactive?: boolean }>()
      .catch(() => ({ focus: undefined, full: undefined, interactive: undefined }))
    const focus = body.focus === 'review' ? 'review' : 'mine'
    noteListFocus(focus)
    return c.json(
      await refreshSnapshot(db, focus, {
        full: body.full === true,
        interactive: body.interactive === true,
      }),
    )
  } catch (error) {
    if (error instanceof SyncCancelled) return c.json({ error: 'Sync cancelled' }, 409)
    return c.json({ error: messageOf(error) }, 500)
  }
})

app.post('/api/feedback', async (c) => {
  try {
    const body = await c.req.json<{ focus?: string }>().catch(() => ({ focus: undefined }))
    const focus = body.focus === 'review' ? 'review' : 'mine'
    return c.json(await loadThreadFeedback(db, focus))
  } catch (error) {
    if (error instanceof SyncCancelled) return c.json({ error: 'Sync cancelled' }, 409)
    return c.json({ error: messageOf(error) }, 500)
  }
})

app.post('/api/pulls/refresh', async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>()
    const key = body.key ?? ''
    if (!key) return c.json({ error: 'A pull request is required.' }, 400)
    return c.json(await refreshPull(db, key))
  } catch (error) {
    if (error instanceof SyncCancelled) return c.json({ error: 'Sync cancelled' }, 409)
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.post('/api/pulls/ready', async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>()
    const key = body.key ?? ''
    if (!key) return c.json({ error: 'A pull request is required.' }, 400)
    const snap = db.snapshot()
    const pr = snap.pullRequests.find((item) => item.key === key)
    if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
    if (!pr.isDraft) return c.json({ error: 'That pull request is already ready for review.' }, 409)
    await markPullReadyForReview(loadGithubToken(), pr.id)
    return c.json(await refreshPull(db, key))
  } catch (error) {
    if (error instanceof SyncCancelled) return c.json({ error: 'Sync cancelled' }, 409)
    return c.json({ error: messageOf(error) }, 502)
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

app.get('/api/linear/issues', async (c) => {
  const token = linearToken()
  if (!token) return c.json({ error: 'Set LINEAR_API_KEY to update Linear.' }, 400)
  const query = c.req.query('q')?.trim() ?? ''
  if (query.length < 2) return c.json({ issues: [] })
  try {
    return c.json({ issues: await searchLinearIssues(token, query) })
  } catch (error) {
    return c.json({ error: messageOf(error) }, 502)
  }
})

app.post('/api/linear/links', async (c) => {
  const token = linearToken()
  if (!token) return c.json({ error: 'Set LINEAR_API_KEY to update Linear.' }, 400)
  try {
    const body = await c.req.json<{ key?: string; identifier?: string }>()
    const key = body.key?.trim() ?? ''
    const identifier = body.identifier?.trim().toUpperCase() ?? ''
    if (!key || !isLinearIdentifier(identifier)) return c.json({ error: 'A pull request and a Linear issue identifier are required.' }, 400)
    const snap = db.snapshot()
    const pr = [...snap.pullRequests, ...snap.reviewPullRequests].find((item) => item.key === key)
    if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
    const issue = await linkGitHubPullRequest(token, identifier, pr.url, pr.title)
    return c.json(db.attachLinearIssue(pr.key, issue))
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

app.post('/api/merge-when-ready', async (c) => {
  try {
    const body = await c.req.json<{ key?: string; scope?: 'pr' | 'downstack'; enabled?: boolean }>()
    const key = body.key ?? ''
    if (!key) return c.json({ error: 'A pull request is required.' }, 400)
    if (body.scope !== 'pr' && body.scope !== 'downstack') {
      return c.json({ error: 'scope must be pr or downstack.' }, 400)
    }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean.' }, 400)
    await setMergeWhenReady(db, key, body.scope, body.enabled)
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
    const prs = listedPulls(db.snapshot()).filter((pr) => keys.has(pr.key))
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

app.post('/api/rebase', async (c) => {
  try {
    const body = await c.req.json<{ key?: string }>()
    const key = body.key ?? ''
    if (!key) return c.json({ error: 'A pull request is required.' }, 400)
    return c.json(await rebasePull(db, key))
  } catch (error) {
    const status = error instanceof RebaseRejected ? 409 : 502
    return c.json({ error: messageOf(error) }, status)
  }
})

app.get('/api/feedback', async (c) => {
  const key = c.req.query('key') ?? ''
  return publishFeedback(c, key, (token, pr) => fetchPullFeedback(token, pr.repo, pr.number))
})

app.post('/api/feedback/reply', async (c) => {
  const body = await c.req.json<{ key?: string; threadId?: string; body?: string }>().catch(() => ({ key: '', threadId: '', body: '' }))
  if (!body.threadId) return c.json({ error: 'A review thread is required.' }, 400)
  return publishFeedback(c, body.key ?? '', (token, pr) => replyToReviewThread(token, pr.repo, pr.number, body.threadId ?? '', body.body ?? ''))
})

app.post('/api/feedback/note', async (c) => {
  const body = await c.req.json<{ key?: string; noteId?: string; body?: string }>().catch(() => ({ key: '', noteId: '', body: '' }))
  if (!body.noteId) return c.json({ error: 'A comment is required.' }, 400)
  return publishFeedback(c, body.key ?? '', (token, pr) => replyToPullNote(token, pr.repo, pr.number, body.noteId ?? '', body.body ?? ''))
})

app.post('/api/feedback/resolve', async (c) => {
  const body = await c.req.json<{ key?: string; threadId?: string; resolved?: boolean }>().catch(() => ({ key: '', threadId: '', resolved: false }))
  if (!body.threadId || typeof body.resolved !== 'boolean') return c.json({ error: 'A review thread and resolved flag are required.' }, 400)
  return publishFeedback(c, body.key ?? '', (token, pr) => setReviewThreadResolved(token, pr.repo, pr.number, body.threadId ?? '', body.resolved === true))
})

app.post('/api/pulls/agents', async (c) => {
  const body = await c.req.json<{ key?: string }>().catch(() => null)
  const request = parseAgentRequest(body)
  if (!body?.key || !request) return c.json({ error: 'A pull request and an agent kind are required.' }, 400)
  const pr = listedPulls(db.snapshot()).find((item) => item.key === body.key)
  if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
  const blocked = agentBlocker(pr, request)
  if (blocked) return c.json({ error: blocked }, 409)
  try {
    const session = await startCursorAgent(pr, request)
    db.saveCursorSession(pr.key, session)
    return c.json({ snapshot: db.snapshot(), agentId: session.agentId })
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
startBackgroundSync(db)

const port = Number(process.env.PORT ?? 4317)
const hostname = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`pr-dash API on http://${hostname}:${port}`)
})

async function publishFeedback(c: Context, key: string, load: (token: string, pr: PullRequest) => Promise<FeedbackDetail>) {
  const pr = listedPulls(db.snapshot()).find((item) => item.key === key)
  if (!pr) return c.json({ error: 'That pull request is no longer in this list.' }, 404)
  try {
    const detail = await load(loadGithubToken(), pr)
    const payload = payloadFor(detail, db.snapshot().viewer ?? '')
    db.patchFeedback(pr.key, { ...payload.counts, feedbackAt: pr.updatedAt })
    return c.json(payload)
  } catch (error) {
    const status = error instanceof Error && error.name === 'FeedbackRejected' ? 400 : error instanceof Error && error.name === 'GraphqlPaused' ? 503 : 502
    return c.json({ error: messageOf(error) }, status)
  }
}

function listedPulls(snap: Snapshot): PullRequest[] {
  return [...snap.pullRequests, ...snap.reviewPullRequests]
}

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

function linearToken(): string | null {
  const token = process.env.LINEAR_API_KEY
  return token && token.length > 0 ? token : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed'
}
