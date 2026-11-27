import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.ts'
import { loadEnv } from './env.ts'
import { openDatabase } from './db.ts'
import { startMergeWorker } from './merge-worker.ts'
import { isLoopback } from './origin.ts'
import { startBackgroundSync } from './sync.ts'

loadEnv()

const db = openDatabase()

const port = Number(process.env.PORT ?? 4317)
const hostname = process.env.HOST ?? '127.0.0.1'
const app = createApp(db, { loopbackOnly: isLoopback(hostname), address: `http://${hostname}:${port}` })

const webRoot = path.resolve('dist/web')
if (existsSync(path.join(webRoot, 'index.html'))) {
  app.use('/assets/*', serveStatic({ root: webRoot }))
  app.get('*', (c) => c.html(readFileSync(path.join(webRoot, 'index.html'), 'utf8')))
}

startMergeWorker(db)
startBackgroundSync(db)

serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`pr-dash API on http://${hostname}:${port}`)
})
