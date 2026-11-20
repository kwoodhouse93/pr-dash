import type { DatabaseSync } from 'node:sqlite'
import { pullKeyRepo, repoKeyLike } from '../shared/repos.ts'
import type { PullRequest } from '../shared/types.ts'
import type { EntryStatus, MergeEntry, MergeLog, MergeStep, MergeWatch, QueueSnapshot, StepStatus } from '../shared/queue.ts'

export type NewStep = {
  prKey: string
  number: number
  title: string
  url: string
  headRef: string
  headOid: string
  baseRef: string
  role: 'merge' | 'restack'
}

export type NewEntry = {
  kind: 'pr' | 'stack'
  repo: string
  trunk: string
  title: string
  steps: NewStep[]
}

type EntryRow = {
  id: string
  position: number
  kind: 'pr' | 'stack'
  repo: string
  trunk: string
  title: string
  status: EntryStatus
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

type StepRow = {
  id: string
  entry_id: string
  position: number
  pr_key: string
  number: number
  title: string
  url: string
  head_ref: string
  head_oid: string
  base_ref: string
  role: 'merge' | 'restack'
  status: StepStatus
  detail: string | null
}

const OPEN = `status IN ('queued', 'active', 'failed') AND archived = 0`

export type QueueStore = ReturnType<typeof attachQueue>

export function attachQueue(db: DatabaseSync, hooks: { onMerged?: (prKey: string) => void } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_entries (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      trunk TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS merge_steps (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES merge_entries(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      pr_key TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merge_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    DROP TABLE IF EXISTS merge_worker;
    CREATE TABLE IF NOT EXISTS merge_retained (
      pr_key TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      pull_request TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merge_hold_releases (
      pr_key TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS merge_watches (
      root_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      repo TEXT NOT NULL,
      keys TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
  `)

  const readEntries = db.prepare(
    `SELECT id, position, kind, repo, trunk, title, status, error, created_at, updated_at, started_at, finished_at
     FROM merge_entries ORDER BY position ASC`,
  )
  const readSteps = db.prepare(
    `SELECT id, entry_id, position, pr_key, number, title, url, head_ref, head_oid, base_ref, role, status, detail
     FROM merge_steps ORDER BY position ASC`,
  )
  const readLogs = db.prepare(
    `SELECT id, entry_id, at, level, message FROM merge_logs ORDER BY id ASC`,
  )

  function allSteps(): Map<string, MergeStep[]> {
    const map = new Map<string, MergeStep[]>()
    for (const row of readSteps.all() as StepRow[]) {
      const list = map.get(row.entry_id) ?? []
      list.push({
        id: row.id,
        position: row.position,
        prKey: row.pr_key,
        number: row.number,
        title: row.title,
        url: row.url,
        headRef: row.head_ref,
        headOid: row.head_oid,
        baseRef: row.base_ref,
        role: row.role,
        status: row.status,
        detail: row.detail,
      })
      map.set(row.entry_id, list)
    }
    return map
  }

  function logsFor(entryId: string): MergeLog[] {
    return (readLogs.all() as { id: number; entry_id: string; at: string; level: 'info' | 'error'; message: string }[])
      .filter((row) => row.entry_id === entryId)
      .slice(-200)
      .map((row) => ({ id: row.id, at: row.at, level: row.level, message: row.message }))
  }

  function entryFrom(row: EntryRow, steps: Map<string, MergeStep[]>, withLogs: boolean): MergeEntry {
    return {
      id: row.id,
      position: row.position,
      kind: row.kind,
      repo: row.repo,
      trunk: row.trunk,
      title: row.title,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      steps: steps.get(row.id) ?? [],
      logs: withLogs ? logsFor(row.id) : [],
    }
  }

  function load(id: string): MergeEntry | null {
    const row = db.prepare(
      `SELECT id, position, kind, repo, trunk, title, status, error, created_at, updated_at, started_at, finished_at
       FROM merge_entries WHERE id = ?`,
    ).get(id) as EntryRow | undefined
    if (!row) return null
    return entryFrom(row, allSteps(), false)
  }

  function touch(id: string) {
    db.prepare('UPDATE merge_entries SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  }

  // Latest merge step for a pull request, when that step landed.
  const LANDED = `
    SELECT s.pr_key AS pr_key
    FROM merge_steps s
    WHERE s.role = 'merge' AND s.status = 'merged'
      AND NOT EXISTS (
        SELECT 1 FROM merge_steps later
        WHERE later.role = 'merge'
          AND later.pr_key = s.pr_key
          AND (
            later.updated_at > s.updated_at
            OR (later.updated_at = s.updated_at AND later.rowid > s.rowid)
          )
      )
  `

  function keySet(sql: string): Set<string> {
    const rows = db.prepare(sql).all() as { pr_key: string }[]
    return new Set(rows.map((row) => row.pr_key))
  }

  function clearHoldRelease(prKey: string) {
    db.prepare('DELETE FROM merge_hold_releases WHERE pr_key = ?').run(prKey)
  }

  function watches(): MergeWatch[] {
    return (
      db.prepare('SELECT root_key, scope, keys, detail, created_at FROM merge_watches ORDER BY created_at ASC').all() as {
        root_key: string
        scope: MergeWatch['scope']
        keys: string
        detail: string | null
        created_at: string
      }[]
    ).map((row) => ({
      key: row.root_key,
      scope: row.scope,
      keys: JSON.parse(row.keys) as string[],
      detail: row.detail,
      createdAt: row.created_at,
    }))
  }

  const store = {
    snapshot(): QueueSnapshot {
      const steps = allSteps()
      const rows = readEntries.all() as (EntryRow & { archived: number })[]
      const archived = db.prepare('SELECT id, archived FROM merge_entries').all() as { id: string; archived: number }[]
      const archivedIds = new Set(archived.filter((row) => row.archived === 1).map((row) => row.id))
      const entries = rows
        .filter((row) => !archivedIds.has(row.id) && (row.status === 'queued' || row.status === 'active' || row.status === 'failed'))
        .map((row) => entryFrom(row, steps, true))
      const history = rows
        .filter((row) => archivedIds.has(row.id) || row.status === 'done' || row.status === 'cancelled')
        .map((row) => entryFrom(row, steps, true))
        .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt))
        .slice(0, 40)
      return {
        entries,
        history,
        watches: watches(),
      }
    },

    get(id: string) {
      return load(id)
    },

    blocksKey(key: string): boolean {
      const row = db.prepare(
        `SELECT 1 FROM merge_steps s JOIN merge_entries e ON e.id = s.entry_id
         WHERE s.pr_key = ? AND e.archived = 0 AND e.status IN ('queued', 'active', 'failed')`,
      ).get(key)
      return row != null
    },

    repoActive(repo: string): boolean {
      const row = db.prepare(`SELECT 1 FROM merge_entries WHERE repo = ? AND status = 'active' AND archived = 0`).get(repo)
      return row != null
    },

    repos(): string[] {
      const names = new Set<string>()
      for (const row of db.prepare('SELECT repo FROM merge_entries').all() as { repo: string }[]) names.add(row.repo)
      for (const row of db.prepare('SELECT pr_key FROM merge_retained').all() as { pr_key: string }[]) {
        const repo = pullKeyRepo(row.pr_key)
        if (repo) names.add(repo)
      }
      for (const row of db.prepare('SELECT repo FROM merge_watches').all() as { repo: string }[]) names.add(row.repo)
      return [...names]
    },

    forgetRepo(repo: string) {
      const like = repoKeyLike(repo)
      const entries = db.prepare('SELECT id FROM merge_entries WHERE repo = ?').all(repo) as { id: string }[]
      for (const entry of entries) {
        db.prepare('DELETE FROM merge_logs WHERE entry_id = ?').run(entry.id)
        db.prepare('DELETE FROM merge_entries WHERE id = ?').run(entry.id)
      }
      db.prepare(`DELETE FROM merge_steps WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
      db.prepare(`DELETE FROM merge_retained WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
      db.prepare(`DELETE FROM merge_hold_releases WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
      db.prepare('DELETE FROM merge_watches WHERE repo = ?').run(repo)
    },

    watches,

    armWatch(input: { key: string; scope: MergeWatch['scope']; repo: string; keys: string[] }) {
      db.prepare(
        `INSERT INTO merge_watches (root_key, scope, repo, keys, detail, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(root_key) DO UPDATE SET
           scope = excluded.scope,
           repo = excluded.repo,
           keys = excluded.keys,
           detail = NULL,
           created_at = excluded.created_at`,
      ).run(input.key, input.scope, input.repo, JSON.stringify(input.keys), new Date().toISOString())
    },

    setWatchDetail(key: string, detail: string | null) {
      db.prepare('UPDATE merge_watches SET detail = ? WHERE root_key = ?').run(detail, key)
    },

    disarmWatch(key: string) {
      db.prepare('DELETE FROM merge_watches WHERE root_key = ?').run(key)
    },

    isCancelRequested(id: string): boolean {
      const row = db.prepare('SELECT cancel_requested FROM merge_entries WHERE id = ?').get(id) as
        | { cancel_requested: number }
        | undefined
      return row?.cancel_requested === 1
    },

    enqueue(input: NewEntry): MergeEntry {
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      const position = (
        db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM merge_entries').get() as { next: number }
      ).next
      const insertStep = db.prepare(
        `INSERT INTO merge_steps (
           id, entry_id, position, pr_key, number, title, url, head_ref, head_oid, base_ref, role, status, detail, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?)`,
      )
      db.exec('BEGIN')
      try {
        db.prepare(
          `INSERT INTO merge_entries (
             id, position, kind, repo, trunk, title, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(id, position, input.kind, input.repo, input.trunk, input.title, now, now)
        input.steps.forEach((step, index) => {
          insertStep.run(
            crypto.randomUUID(),
            id,
            index,
            step.prKey,
            step.number,
            step.title,
            step.url,
            step.headRef,
            step.headOid.toLowerCase(),
            step.baseRef,
            step.role,
            now,
          )
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      const numbers = input.steps.filter((step) => step.role === 'merge').map((step) => `#${step.number}`)
      store.log(id, 'info', `Queued ${numbers.join(', ')} on ${input.trunk}.`)
      const entry = load(id)
      if (!entry) throw new Error('Could not read the queued merge.')
      return entry
    },

    log(entryId: string, level: 'info' | 'error', message: string) {
      db.prepare('INSERT INTO merge_logs (entry_id, at, level, message) VALUES (?, ?, ?, ?)').run(
        entryId,
        new Date().toISOString(),
        level,
        message,
      )
    },

    markActive(id: string) {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE merge_entries SET status = 'active', started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL WHERE id = ?`,
      ).run(now, now, id)
    },

    setStep(id: string, status: StepStatus, detail: string | null) {
      if (status === 'merged') {
        const row = db.prepare('SELECT pr_key FROM merge_steps WHERE id = ?').get(id) as { pr_key: string } | undefined
        if (row) clearHoldRelease(row.pr_key)
        if (row) hooks.onMerged?.(row.pr_key)
      }
      db.prepare('UPDATE merge_steps SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(
        status,
        detail,
        new Date().toISOString(),
        id,
      )
    },

    setHeadOid(id: string, oid: string) {
      db.prepare('UPDATE merge_steps SET head_oid = ?, updated_at = ? WHERE id = ?').run(
        oid.toLowerCase(),
        new Date().toISOString(),
        id,
      )
    },

    markDone(id: string) {
      const now = new Date().toISOString()
      db.prepare(`UPDATE merge_entries SET status = 'done', finished_at = ?, updated_at = ?, error = NULL WHERE id = ?`).run(
        now,
        now,
        id,
      )
    },

    /** Holds the entry aside with its reason. Entries behind it keep running. */
    fail(id: string, stepId: string | null, message: string) {
      const now = new Date().toISOString()
      if (stepId) {
        db.prepare(`UPDATE merge_steps SET status = 'failed', detail = ?, updated_at = ? WHERE id = ?`).run(message, now, stepId)
      }
      db.prepare(
        `UPDATE merge_entries SET status = 'failed', error = ?, finished_at = ?, updated_at = ?, cancel_requested = 0 WHERE id = ?`,
      ).run(message, now, now, id)
      store.log(id, 'error', message)
    },

    /**
     * Puts a held entry back in line where it stood. Unfinished steps take the head and base
     * GitHub reports now, so a fix pushed since the failure is what gets merged.
     */
    retry(id: string, live: { stepId: string; headOid: string; baseRef: string; restacked: boolean }[]) {
      const entry = load(id)
      if (!entry) throw new Error('That merge is no longer in the queue.')
      if (entry.status !== 'failed') throw new Error('Only a held merge can be retried.')
      const now = new Date().toISOString()
      db.exec('BEGIN')
      try {
        db.prepare(
          `UPDATE merge_steps SET status = 'queued', detail = NULL, updated_at = ?
           WHERE entry_id = ? AND status NOT IN ('merged', 'restacked', 'cancelled')`,
        ).run(now, id)
        for (const step of live) {
          db.prepare(
            `UPDATE merge_steps SET head_oid = ?, base_ref = ?, status = ?, updated_at = ?
             WHERE id = ? AND entry_id = ? AND status = 'queued'`,
          ).run(step.headOid.toLowerCase(), step.baseRef, step.restacked ? 'restacked' : 'queued', now, step.stepId, id)
        }
        db.prepare(
          `UPDATE merge_entries SET status = 'queued', error = NULL, finished_at = NULL, cancel_requested = 0, updated_at = ? WHERE id = ?`,
        ).run(now, id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      store.log(id, 'info', 'Retrying.')
    },

    requestCancel(id: string): 'later' | 'now' {
      const entry = load(id)
      if (!entry) throw new Error('That merge is no longer in the queue.')
      if (entry.status === 'active') {
        db.prepare('UPDATE merge_entries SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
        store.log(id, 'info', 'Cancel requested. Stopping before the next change.')
        return 'later'
      }
      if (entry.status !== 'queued' && entry.status !== 'failed') {
        throw new Error('That merge has already finished.')
      }
      store.finishCancelled(id)
      return 'now'
    },

    finishCancelled(id: string) {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE merge_steps SET status = 'cancelled', updated_at = ?
         WHERE entry_id = ? AND status NOT IN ('merged', 'restacked')`,
      ).run(now, id)
      db.prepare(
        `UPDATE merge_entries SET status = 'cancelled', cancel_requested = 0, finished_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, id)
      store.log(id, 'info', 'Cancelled. No further merges will run for this entry.')
      touch(id)
    },

    move(id: string, direction: 'up' | 'down') {
      const entry = load(id)
      if (!entry) throw new Error('That merge is no longer in the queue.')
      if (entry.status !== 'queued') throw new Error('Only a queued merge can be reordered.')
      const neighbor = db.prepare(
        direction === 'up'
          ? `SELECT id, position FROM merge_entries
             WHERE archived = 0 AND status = 'queued' AND repo = ? AND position < ? ORDER BY position DESC LIMIT 1`
          : `SELECT id, position FROM merge_entries
             WHERE archived = 0 AND status = 'queued' AND repo = ? AND position > ? ORDER BY position ASC LIMIT 1`,
      ).get(entry.repo, entry.position) as { id: string; position: number } | undefined
      if (!neighbor) return
      db.exec('BEGIN')
      try {
        db.prepare('UPDATE merge_entries SET position = ? WHERE id = ?').run(neighbor.position, entry.id)
        db.prepare('UPDATE merge_entries SET position = ? WHERE id = ?').run(entry.position, neighbor.id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    /** Repos with an entry in flight or waiting. Each one runs its own line. */
    runnableRepos(): string[] {
      const rows = db.prepare(
        `SELECT DISTINCT repo FROM merge_entries WHERE status IN ('queued', 'active') AND archived = 0`,
      ).all() as { repo: string }[]
      return rows.map((row) => row.repo)
    },

    nextRunnable(repo: string): MergeEntry | null {
      const active = db.prepare(
        `SELECT id FROM merge_entries WHERE status = 'active' AND archived = 0 AND repo = ? ORDER BY position ASC LIMIT 1`,
      ).get(repo) as { id: string } | undefined
      if (active) return load(active.id)
      const queued = db.prepare(
        `SELECT id FROM merge_entries WHERE ${OPEN} AND status = 'queued' AND repo = ? ORDER BY position ASC LIMIT 1`,
      ).get(repo) as { id: string } | undefined
      return queued ? load(queued.id) : null
    },

    retain(entryId: string, pr: PullRequest) {
      db.prepare(
        `INSERT INTO merge_retained (pr_key, entry_id, pull_request) VALUES (?, ?, ?)
         ON CONFLICT(pr_key) DO UPDATE SET entry_id = excluded.entry_id, pull_request = excluded.pull_request`,
      ).run(pr.key, entryId, JSON.stringify(pr))
    },

    release(keys: string[]) {
      const remove = db.prepare('DELETE FROM merge_retained WHERE pr_key = ?')
      for (const key of keys) remove.run(key)
    },

    /** Pull requests whose latest merge-queue attempt landed. */
    landedKeys(): Set<string> {
      return keySet(LANDED)
    },

    /**
     * Landed merges to keep off the dashboard. A release means a later read
     * found the pull request still open, so the merge did not stick.
     */
    heldKeys(): Set<string> {
      return keySet(
        `SELECT landed.pr_key AS pr_key FROM (${LANDED}) landed
         WHERE NOT EXISTS (SELECT 1 FROM merge_hold_releases r WHERE r.pr_key = landed.pr_key)`,
      )
    },

    releaseHold(prKey: string) {
      db.prepare('INSERT INTO merge_hold_releases (pr_key) VALUES (?) ON CONFLICT(pr_key) DO NOTHING').run(prKey)
    },

    clearHoldRelease(prKey: string) {
      clearHoldRelease(prKey)
    },

    takeRetained(entryId: string): string[] {
      const rows = db.prepare('SELECT pr_key FROM merge_retained WHERE entry_id = ?').all(entryId) as { pr_key: string }[]
      db.prepare('DELETE FROM merge_retained WHERE entry_id = ?').run(entryId)
      return rows.map((row) => row.pr_key)
    },

    overlay(pullRequests: PullRequest[]): PullRequest[] {
      const rows = db.prepare('SELECT pr_key, pull_request FROM merge_retained').all() as {
        pr_key: string
        pull_request: string
      }[]
      if (rows.length === 0) return pullRequests
      const seen = new Set(pullRequests.map((pr) => pr.key))
      const extra = rows
        .filter((row) => !seen.has(row.pr_key))
        .map((row) => JSON.parse(row.pull_request) as PullRequest)
      return [...pullRequests, ...extra]
    },
  }

  return store
}
