import type { ListName } from '../../shared/types.ts'
import { pullGone, Refused } from '../errors.ts'
import { loadGithubToken } from '../github-client.ts'
import { markPullReadyForReview } from '../github-pull.ts'
import { cancelQueuedSync, describeSync, enqueueSync, loadThreadFeedback, noteListFocus, refreshPull, refreshSnapshot } from '../sync.ts'
import { read, required, type Routes } from './http.ts'

function focusOf(value: unknown): ListName {
  return value === 'review' ? 'review' : 'mine'
}

export const syncRoutes: Routes = (app, db) => {
  app.get('/api/snapshot', (c) => {
    const focus = c.req.query('focus')
    if (focus === 'mine' || focus === 'review') noteListFocus(focus)
    return c.json(db.snapshot())
  })

  app.get('/api/activity', (c) => c.json(db.activity()))

  app.get('/api/status', (c) => c.json(describeSync(db)))

  app.post('/api/sync', async (c) => {
    const body = await read<{ kind: string; focus: string }>(c)
    if (body.kind !== 'full' && body.kind !== 'rules') throw new Refused('Choose a full sync or a ruleset sync.')
    const focus = focusOf(body.focus)
    noteListFocus(focus)
    return c.json(enqueueSync(db, body.kind, focus))
  })

  app.post('/api/sync/:id/cancel', (c) => c.json(cancelQueuedSync(db, c.req.param('id'))))

  app.post('/api/refresh', async (c) => {
    const body = await read<{ focus: string; full: boolean; interactive: boolean }>(c)
    const focus = focusOf(body.focus)
    noteListFocus(focus)
    return c.json(await refreshSnapshot(db, focus, { full: body.full === true, interactive: body.interactive === true }))
  })

  app.post('/api/feedback', async (c) => {
    const body = await read<{ focus: string }>(c)
    return c.json(await loadThreadFeedback(db, focusOf(body.focus)))
  })

  app.post('/api/pulls/refresh', async (c) => {
    const key = required((await read<{ key: string }>(c)).key)
    return c.json(await refreshPull(db, key))
  })

  app.post('/api/pulls/ready', async (c) => {
    const key = required((await read<{ key: string }>(c)).key)
    const pr = db.snapshot().pullRequests.find((item) => item.key === key)
    if (!pr) throw pullGone()
    if (!pr.isDraft) throw new Refused('That pull request is already ready for review.', 409)
    await markPullReadyForReview(loadGithubToken(), pr.id)
    return c.json(await refreshPull(db, key))
  })
}
