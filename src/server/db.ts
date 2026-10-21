import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CursorSession, Initiative, LinearIssue, PullRequest, Snapshot } from '../shared/types.ts'
import { attachQueue, type QueueStore } from './queue-store.ts'

export type DashboardDb = {
  snapshot(): Snapshot
  saveSnapshot(input: {
    viewer: string
    syncedAt: string
    pullRequests: PullRequest[]
    reviewPullRequests?: PullRequest[]
    linearConfigured: boolean
    warning: string | null
  }): Snapshot
  createInitiative(name: string): Initiative
  renameInitiative(id: string, name: string): Initiative
  deleteInitiative(id: string): void
  setAssignments(initiativeId: string, prKeys: string[], action: 'add' | 'remove'): void
  updateLinearIssue(identifier: string, patch: LinearIssue): Snapshot
  saveCursorSession(prKey: string, session: CursorSession): void
  cursorSessions(): { prKey: string; session: CursorSession }[]
  queue: QueueStore
}

type SnapshotRow = {
  viewer: string | null
  synced_at: string | null
  linear_configured: number
  warning: string | null
  pull_requests: string
  review_pull_requests: string | null
}

export function openDatabase(file = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'pr-dash.sqlite')): DashboardDb {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      viewer TEXT,
      synced_at TEXT,
      linear_configured INTEGER NOT NULL DEFAULT 0,
      warning TEXT,
      pull_requests TEXT NOT NULL DEFAULT '[]',
      review_pull_requests TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS initiatives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS initiative_pull_requests (
      initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
      pr_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (initiative_id, pr_key)
    );
    CREATE TABLE IF NOT EXISTS cursor_sessions (
      pr_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      branch TEXT,
      updated_at TEXT NOT NULL
    );
  `)

  const columns = db.prepare('PRAGMA table_info(snapshot)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'review_pull_requests')) {
    db.exec(`ALTER TABLE snapshot ADD COLUMN review_pull_requests TEXT NOT NULL DEFAULT '[]'`)
  }

  const queue = attachQueue(db)
  const readSnapshotRow = db.prepare(
    'SELECT viewer, synced_at, linear_configured, warning, pull_requests, review_pull_requests FROM snapshot WHERE id = 1',
  )
  const readInitiatives = db.prepare('SELECT id, name, created_at, updated_at FROM initiatives ORDER BY created_at ASC')
  const readAssignments = db.prepare('SELECT initiative_id, pr_key FROM initiative_pull_requests')
  const readCursorSessions = db.prepare(
    'SELECT pr_key, agent_id, run_id, status, result, branch, updated_at FROM cursor_sessions',
  )
  const writeCursorSession = db.prepare(
    `INSERT INTO cursor_sessions (pr_key, agent_id, run_id, status, result, branch, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pr_key) DO UPDATE SET
       agent_id = excluded.agent_id,
       run_id = excluded.run_id,
       status = excluded.status,
       result = excluded.result,
       branch = excluded.branch,
       updated_at = excluded.updated_at`,
  )

  function initiatives(): Initiative[] {
    return (readInitiatives.all() as { id: string; name: string; created_at: string; updated_at: string }[]).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  function assignments(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const row of readAssignments.all() as { initiative_id: string; pr_key: string }[]) {
      const list = map.get(row.pr_key) ?? []
      list.push(row.initiative_id)
      map.set(row.pr_key, list)
    }
    return map
  }

  function cursorSessions(): { prKey: string; session: CursorSession }[] {
    return (readCursorSessions.all() as {
      pr_key: string
      agent_id: string
      run_id: string
      status: CursorSession['status']
      result: string | null
      branch: string | null
      updated_at: string
    }[]).map((row) => ({
      prKey: row.pr_key,
      session: {
        agentId: row.agent_id,
        runId: row.run_id,
        status: row.status,
        result: row.result,
        branch: row.branch,
        updatedAt: row.updated_at,
      },
    }))
  }

  function decorate(list: PullRequest[], tags: Map<string, string[]>, sessions: Map<string, CursorSession>): PullRequest[] {
    return list.map((pr) => ({
      ...pr,
      initiativeIds: tags.get(pr.key) ?? [],
      cursorSession: sessions.get(pr.key) ?? null,
    }))
  }

  function parseList(raw: string | null | undefined): PullRequest[] {
    if (!raw) return []
    return JSON.parse(raw) as PullRequest[]
  }

  function snapshot(): Snapshot {
    const row = readSnapshotRow.get() as SnapshotRow | undefined
    const tags = assignments()
    const sessions = new Map(cursorSessions().map((item) => [item.prKey, item.session]))
    return {
      viewer: row?.viewer ?? null,
      syncedAt: row?.synced_at ?? null,
      pullRequests: row ? decorate(parseList(row.pull_requests), tags, sessions) : [],
      reviewPullRequests: row ? decorate(parseList(row.review_pull_requests), tags, sessions) : [],
      initiatives: initiatives(),
      linearConfigured: row ? row.linear_configured === 1 : Boolean(process.env.LINEAR_API_KEY),
      warning: row?.warning ?? null,
    }
  }

  function assertUniqueName(name: string, ignoreId?: string) {
    const existing = db.prepare('SELECT id FROM initiatives WHERE lower(name) = lower(?)').get(name) as { id: string } | undefined
    if (existing && existing.id !== ignoreId) {
      const error = new Error(`An initiative named "${name}" already exists.`)
      error.name = 'DuplicateInitiative'
      throw error
    }
  }

  return {
    snapshot,
    saveSnapshot(input) {
      const strip = (list: PullRequest[]) => list.map(({ cursorSession: _session, ...pr }) => ({ ...pr, initiativeIds: [] }))
      const existing = readSnapshotRow.get() as SnapshotRow | undefined
      const review = input.reviewPullRequests ?? parseList(existing?.review_pull_requests)
      db.prepare(
        `INSERT INTO snapshot (id, viewer, synced_at, linear_configured, warning, pull_requests, review_pull_requests)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           viewer = excluded.viewer,
           synced_at = excluded.synced_at,
           linear_configured = excluded.linear_configured,
           warning = excluded.warning,
           pull_requests = excluded.pull_requests,
           review_pull_requests = excluded.review_pull_requests`,
      ).run(
        input.viewer,
        input.syncedAt,
        input.linearConfigured ? 1 : 0,
        input.warning,
        JSON.stringify(strip(input.pullRequests)),
        JSON.stringify(strip(review)),
      )
      return snapshot()
    },
    createInitiative(name) {
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) throw new Error('Initiative name must be 1–80 characters.')
      assertUniqueName(trimmed)
      const now = new Date().toISOString()
      const initiative: Initiative = { id: crypto.randomUUID(), name: trimmed, createdAt: now, updatedAt: now }
      db.prepare('INSERT INTO initiatives (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        initiative.id,
        initiative.name,
        initiative.createdAt,
        initiative.updatedAt,
      )
      return initiative
    },
    renameInitiative(id, name) {
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) throw new Error('Initiative name must be 1–80 characters.')
      assertUniqueName(trimmed, id)
      const now = new Date().toISOString()
      const result = db.prepare('UPDATE initiatives SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id)
      if (Number(result.changes) === 0) throw new Error('Initiative not found.')
      return { id, name: trimmed, createdAt: now, updatedAt: now }
    },
    deleteInitiative(id) {
      db.prepare('DELETE FROM initiatives WHERE id = ?').run(id)
    },
    setAssignments(initiativeId, prKeys, action) {
      const found = db.prepare('SELECT id FROM initiatives WHERE id = ?').get(initiativeId)
      if (!found) throw new Error('Initiative not found.')
      const now = new Date().toISOString()
      const insert = db.prepare(
        'INSERT INTO initiative_pull_requests (initiative_id, pr_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      )
      const remove = db.prepare('DELETE FROM initiative_pull_requests WHERE initiative_id = ? AND pr_key = ?')
      db.exec('BEGIN')
      try {
        for (const key of prKeys) {
          if (action === 'add') insert.run(initiativeId, key, now)
          else remove.run(initiativeId, key)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    cursorSessions,
    saveCursorSession(prKey, session) {
      writeCursorSession.run(prKey, session.agentId, session.runId, session.status, session.result, session.branch, session.updatedAt)
    },
    queue,
    updateLinearIssue(identifier, patch) {
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      if (!row) throw new Error('Refresh pull requests before updating a Linear issue.')
      const pullRequests = parseList(row.pull_requests)
      const reviewPullRequests = parseList(row.review_pull_requests)
      const id = identifier.toUpperCase()
      let found = false
      for (const pr of [...pullRequests, ...reviewPullRequests]) {
        for (const issue of pr.linearIssues) {
          if (issue.identifier.toUpperCase() !== id) continue
          found = true
          if (patch.title) issue.title = patch.title
          if (patch.url) issue.url = patch.url
          issue.projectId = patch.projectId
          issue.projectName = patch.projectName
          issue.teamId = patch.teamId
          issue.status = patch.status
          issue.assignee = patch.assignee
        }
      }
      if (!found) throw new Error(`Issue ${identifier} is not on an open pull request.`)
      const strip = (list: PullRequest[]) => list.map((pr) => ({ ...pr, initiativeIds: [] }))
      db.prepare('UPDATE snapshot SET pull_requests = ?, review_pull_requests = ? WHERE id = 1').run(
        JSON.stringify(strip(pullRequests)),
        JSON.stringify(strip(reviewPullRequests)),
      )
      return snapshot()
    },
  }
}
