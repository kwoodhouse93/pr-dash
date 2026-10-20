import type { DashboardDb } from './db.ts'
import { fetchAuthoredPullRequests, loadGithubToken } from './github.ts'
import { enrichLinearProjects } from './linear.ts'
import type { Snapshot } from '../shared/types.ts'

export const syncStatus = { running: false, message: 'Idle' }

let inflight: Promise<Snapshot> | null = null

export function refreshSnapshot(db: DashboardDb): Promise<Snapshot> {
  if (inflight) return inflight
  inflight = run(db).finally(() => {
    inflight = null
    syncStatus.running = false
    syncStatus.message = 'Idle'
  })
  return inflight
}

async function run(db: DashboardDb): Promise<Snapshot> {
  syncStatus.running = true
  syncStatus.message = 'Starting refresh'
  const token = loadGithubToken()
  const fetched = await fetchAuthoredPullRequests(token, (message) => {
    syncStatus.message = message
  })
  let warning = fetched.warning
  const linearKey = process.env.LINEAR_API_KEY
  if (linearKey) {
    syncStatus.message = 'Reading Linear projects'
    try {
      await enrichLinearProjects(fetched.pullRequests, linearKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Linear request failed'
      warning = warning ? `${warning}; ${message}` : message
    }
  }
  syncStatus.message = 'Saving'
  return db.saveSnapshot({
    viewer: fetched.viewer,
    syncedAt: new Date().toISOString(),
    pullRequests: fetched.pullRequests,
    linearConfigured: Boolean(linearKey),
    warning,
  })
}
