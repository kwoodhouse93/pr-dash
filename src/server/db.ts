import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Initiative, LinearIssue, PullRequest, Snapshot } from '../shared/types.ts'

export type DashboardDb = {
  snapshot(): Snapshot
  saveSnapshot(input: {
    viewer: string
    syncedAt: string
    pullRequests: PullRequest[]
    linearConfigured: boolean
    warning: string | null
  }): Snapshot
  createInitiative(name: string): Initiative
  renameInitiative(id: string, name: string): Initiative
  deleteInitiative(id: string): void
  setAssignments(initiativeId: string, prKeys: string[], action: 'add' | 'remove'): void
  updateLinearIssue(identifier: string, patch: LinearIssue): Snapshot
}

type SnapshotRow = {
  viewer: string | null
  synced_at: string | null
  linear_configured: number
  warning: string | null
  pull_requests: string
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
      pull_requests TEXT NOT NULL DEFAULT '[]'
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
  `)

  const readSnapshotRow = db.prepare('SELECT viewer, synced_at, linear_configured, warning, pull_requests FROM snapshot WHERE id = 1')
  const readInitiatives = db.prepare('SELECT id, name, created_at, updated_at FROM initiatives ORDER BY created_at ASC')
  const readAssignments = db.prepare('SELECT initiative_id, pr_key FROM initiative_pull_requests')

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

  function snapshot(): Snapshot {
    const row = readSnapshotRow.get() as SnapshotRow | undefined
    const tags = assignments()
    const pullRequests = row
      ? (JSON.parse(row.pull_requests) as PullRequest[]).map((pr) => ({
          ...pr,
          initiativeIds: tags.get(pr.key) ?? [],
        }))
      : []
    return {
      viewer: row?.viewer ?? null,
      syncedAt: row?.synced_at ?? null,
      pullRequests,
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
      const stripped = input.pullRequests.map((pr) => ({ ...pr, initiativeIds: [] }))
      db.prepare(
        `INSERT INTO snapshot (id, viewer, synced_at, linear_configured, warning, pull_requests)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           viewer = excluded.viewer,
           synced_at = excluded.synced_at,
           linear_configured = excluded.linear_configured,
           warning = excluded.warning,
           pull_requests = excluded.pull_requests`,
      ).run(input.viewer, input.syncedAt, input.linearConfigured ? 1 : 0, input.warning, JSON.stringify(stripped))
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
    updateLinearIssue(identifier, patch) {
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      if (!row) throw new Error('Refresh pull requests before updating a Linear issue.')
      const pullRequests = JSON.parse(row.pull_requests) as PullRequest[]
      const id = identifier.toUpperCase()
      let found = false
      for (const pr of pullRequests) {
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
      const stored = pullRequests.map((pr) => ({ ...pr, initiativeIds: [] }))
      db.prepare('UPDATE snapshot SET pull_requests = ? WHERE id = 1').run(JSON.stringify(stored))
      return snapshot()
    },
  }
}
