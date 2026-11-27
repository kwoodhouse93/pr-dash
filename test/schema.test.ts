import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/server/db.ts'
import { migrate } from '../src/server/schema.ts'

describe('database steps', () => {
  let dir = ''
  let file = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-schema-'))
    file = path.join(dir, 'dash.sqlite')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)

  it('counts the steps a new database has had, and gives it none of them twice', () => {
    openDatabase(file)
    const db = new DatabaseSync(file)
    const after = version(db)
    expect(after).toBeGreaterThan(0)
    db.exec('DROP TABLE merge_logs')
    migrate(db)
    expect(version(db)).toBe(after)
    expect(columns(db, 'merge_logs')).toEqual([])
  })

  it('brings a database from before the steps were counted up to date', () => {
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), viewer TEXT, synced_at TEXT, linear_configured INTEGER NOT NULL DEFAULT 0, warning TEXT, pull_requests TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE cursor_sessions (agent_id TEXT PRIMARY KEY, pr_key TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, branch TEXT, updated_at TEXT NOT NULL);
      INSERT INTO cursor_sessions VALUES ('agent-1', 'acme/app#1', 'run-1', 'finished', 'Resolved', 'feature', '2026-10-20T00:00:00Z');
      CREATE TABLE merge_watches (pr_key TEXT PRIMARY KEY);
    `)
    old.close()

    const snap = openDatabase(file).snapshot()
    expect(snap.reviewPullRequests).toEqual([])

    const db = new DatabaseSync(file)
    expect(columns(db, 'snapshot')).toEqual(expect.arrayContaining(['review_pull_requests', 'mine_synced_at', 'review_synced_at']))
    expect(columns(db, 'merge_steps')).toContain('base_oid')
    expect(columns(db, 'cursor_sessions')).toEqual([])
    expect(columns(db, 'merge_watches')).toEqual([])
    expect(db.prepare('SELECT agent_id, provider, kind FROM agent_sessions').all()).toEqual([{ agent_id: 'agent-1', provider: 'cursor', kind: 'conflict' }])
  })
})
