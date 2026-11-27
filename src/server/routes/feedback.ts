import type { Context } from 'hono'
import type { FeedbackDetail } from '../../shared/feedback.ts'
import type { PullRequest } from '../../shared/types.ts'
import type { DashboardDb } from '../db.ts'
import { COMMENT_GONE, Refused } from '../errors.ts'
import { loadGithubToken } from '../github-client.ts'
import { fetchPullFeedback, payloadFor, replyToPullNote, replyToReviewThread, setReviewThreadResolved } from '../github-feedback.ts'
import { listedPull, read, type Routes } from './http.ts'

/** Does the work, then answers with the pull request's threads as they now stand and stores their counts. */
async function publish(c: Context, db: DashboardDb, key: string | undefined, load: (token: string, pr: PullRequest) => Promise<FeedbackDetail>) {
  const pr = listedPull(db, key)
  const detail = await load(loadGithubToken(), pr)
  const payload = payloadFor(detail, db.snapshot().viewer ?? '', db.localResolutions())
  db.patchFeedback(pr.key, { ...payload.counts, feedbackAt: pr.updatedAt })
  return c.json(payload)
}

export const feedbackRoutes: Routes = (app, db) => {
  app.get('/api/feedback', (c) => publish(c, db, c.req.query('key'), (token, pr) => fetchPullFeedback(token, pr.repo, pr.number)))

  app.post('/api/feedback/reply', async (c) => {
    const body = await read<{ key: string; threadId: string; body: string }>(c)
    const threadId = body.threadId
    if (!threadId) throw new Refused('A review thread is required.')
    return publish(c, db, body.key, (token, pr) => replyToReviewThread(token, pr.repo, pr.number, threadId, body.body ?? ''))
  })

  app.post('/api/feedback/note', async (c) => {
    const body = await read<{ key: string; noteId: string; body: string }>(c)
    const noteId = body.noteId
    if (!noteId) throw new Refused('A comment is required.')
    return publish(c, db, body.key, (token, pr) => replyToPullNote(token, pr.repo, pr.number, noteId, body.body ?? ''))
  })

  app.post('/api/feedback/resolve', async (c) => {
    const body = await read<{ key: string; threadId: string; resolved: boolean }>(c)
    const { threadId, resolved } = body
    if (!threadId || typeof resolved !== 'boolean') throw new Refused('A review thread and resolved flag are required.')
    return publish(c, db, body.key, (token, pr) => setReviewThreadResolved(token, pr.repo, pr.number, threadId, resolved))
  })

  app.post('/api/feedback/local', async (c) => {
    const body = await read<{ key: string; itemId: string; resolved: boolean }>(c)
    const { itemId, resolved } = body
    if (!itemId || typeof resolved !== 'boolean') throw new Refused('A comment and a resolved flag are required.')
    return publish(c, db, body.key, async (token, pr) => {
      const detail = await fetchPullFeedback(token, pr.repo, pr.number)
      if (!detail.notes.some((item) => item.id === itemId)) throw new Refused(COMMENT_GONE, 404)
      db.setLocalResolution(pr.key, itemId, resolved ? new Date().toISOString() : null)
      return detail
    })
  })
}
