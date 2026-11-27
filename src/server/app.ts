import { Hono } from 'hono'
import type { DashboardDb } from './db.ts'
import { failure } from './errors.ts'
import { refusal } from './origin.ts'
import { agentRoutes } from './routes/agents.ts'
import type { RouteOptions } from './routes/http.ts'
import { feedbackRoutes } from './routes/feedback.ts'
import { initiativeRoutes } from './routes/initiatives.ts'
import { linearRoutes } from './routes/linear.ts'
import { queueRoutes } from './routes/queue.ts'
import { repoRoutes } from './routes/repos.ts'
import { syncRoutes } from './routes/sync.ts'

/** The API. `loopbackOnly` is true when the dashboard serves this machine alone, and `address` is where this server answers. */
export function createApp(db: DashboardDb, options: RouteOptions): Hono {
  const app = new Hono()

  app.use('/api/*', async (c, next) => {
    const reason = refusal({ host: c.req.header('host'), origin: c.req.header('origin'), secFetchSite: c.req.header('sec-fetch-site') }, options.loopbackOnly)
    if (reason) return c.json({ error: reason }, 403)
    await next()
  })

  // A route throws what went wrong, and this is the one place that turns it into a response.
  app.onError((error, c) => {
    const { status, body } = failure(error)
    return c.json(body, status)
  })

  for (const routes of [syncRoutes, repoRoutes, initiativeRoutes, linearRoutes, queueRoutes, feedbackRoutes, agentRoutes]) {
    routes(app, db, options)
  }
  return app
}
