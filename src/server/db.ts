import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FeedbackCounts } from '../shared/feedback.ts'
import { pullKeyRepo, repoKeyLike } from '../shared/repos.ts'
import { mergeLinkedIssues } from '../shared/linear.ts'
import type { CursorSession, Initiative, LinearIssue, PullRequest, Snapshot } from '../shared/types.ts'
import { attachQueue, type QueueStore } from './queue-store.ts'

export type CachedRules = {
  repo: string
  checks: string[]
  requiredApprovals: number
  dismissStale: boolean
  fetchedAt: string
}

export type DashboardDb = {
  snapshot(): Snapshot
  saveSnapshot(input: {
    viewer: string
    syncedAt: string
    pullRequests: PullRequest[]
    reviewPullRequests?: PullRequest[]
    linearConfigured: boolean
    warning: string | null
    mineSyncedAt?: string | null
    reviewSyncedAt?: string | null
  }): Snapshot
  ruleCache(): CachedRules[]
  saveRules(repo: string, rules: { checks: string[]; requiredApprovals: number; dismissStale: boolean }, fetchedAt: string): void
  watchedRepos(): string[]
  watchRepo(repo: string): void
  storedRepos(): string[]
  forgetRepo(repo: string): void
  createInitiative(name: string): Initiative
  renameInitiative(id: string, name: string): Initiative
  deleteInitiative(id: string): void
  setAssignments(initiativeId: string, prKeys: string[], action: 'add' | 'remove'): void
  updateLinearIssue(identifier: string, patch: LinearIssue): Snapshot
  linearLinks(): Map<string, string[]>
  attachLinearIssue(prKey: string, issue: LinearIssue): Snapshot
  patchFeedback(key: string, counts: FeedbackCounts & { feedbackAt?: string | null }): void
  saveCursorSession(prKey: string, session: CursorSession): void
  cursorSessions(): { prKey: string; session: CursorSession }[]
  queue: QueueStore
}

type SnapshotRow = {
  viewer: string | null
  synced_at: string | null
  mine_synced_at: string | null
  review_synced_at: string | null
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
    CREATE TABLE IF NOT EXISTS repo_rules (
      repo TEXT PRIMARY KEY,
      checks TEXT NOT NULL,
      required_approvals INTEGER NOT NULL,
      dismiss_stale INTEGER NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_repos (
      repo TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_id TEXT PRIMARY KEY,
      pr_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_pr ON agent_sessions (pr_key, created_at);
    CREATE TABLE IF NOT EXISTS linear_links (
      pr_key TEXT NOT NULL,
      identifier TEXT NOT NULL,
      PRIMARY KEY (pr_key, identifier)
    );
  `)

  const legacySessions = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursor_sessions'").get()
  if (legacySessions) {
    db.exec('BEGIN')
    try {
      db.exec(`
        INSERT OR IGNORE INTO agent_sessions (agent_id, pr_key, kind, prompt, run_id, status, result, branch, created_at, updated_at)
        SELECT agent_id, pr_key, 'conflict', NULL, run_id, status, result, branch, updated_at, updated_at FROM cursor_sessions;
        DROP TABLE cursor_sessions;
      `)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const columns = db.prepare('PRAGMA table_info(snapshot)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'review_pull_requests')) {
    db.exec(`ALTER TABLE snapshot ADD COLUMN review_pull_requests TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!columns.some((column) => column.name === 'mine_synced_at')) {
    db.exec('ALTER TABLE snapshot ADD COLUMN mine_synced_at TEXT')
  }
  if (!columns.some((column) => column.name === 'review_synced_at')) {
    db.exec('ALTER TABLE snapshot ADD COLUMN review_synced_at TEXT')
  }

  const queue = attachQueue(db)
  const readSnapshotRow = db.prepare(
    'SELECT viewer, synced_at, mine_synced_at, review_synced_at, linear_configured, warning, pull_requests, review_pull_requests FROM snapshot WHERE id = 1',
  )
  const readInitiatives = db.prepare('SELECT id, name, created_at, updated_at FROM initiatives ORDER BY created_at ASC')
  const readAssignments = db.prepare('SELECT initiative_id, pr_key FROM initiative_pull_requests')
  const readCursorSessions = db.prepare(
    `SELECT agent_id, pr_key, kind, prompt, run_id, status, result, branch, created_at, updated_at
     FROM agent_sessions ORDER BY created_at DESC, rowid DESC`,
  )
  const writeCursorSession = db.prepare(
    `INSERT INTO agent_sessions (agent_id, pr_key, kind, prompt, run_id, status, result, branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
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
      agent_id: string
      pr_key: string
      kind: CursorSession['kind']
      prompt: string | null
      run_id: string
      status: CursorSession['status']
      result: string | null
      branch: string | null
      created_at: string
      updated_at: string
    }[]).map((row) => ({
      prKey: row.pr_key,
      session: {
        agentId: row.agent_id,
        runId: row.run_id,
        kind: row.kind,
        prompt: row.prompt,
        status: row.status,
        result: row.result,
        branch: row.branch,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }))
  }

  function sessionsByPull(): Map<string, CursorSession[]> {
    const map = new Map<string, CursorSession[]>()
    for (const { prKey, session } of cursorSessions()) {
      const list = map.get(prKey) ?? []
      list.push(session)
      map.set(prKey, list)
    }
    return map
  }

  function linearLinks(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const row of db.prepare('SELECT pr_key, identifier FROM linear_links').all() as { pr_key: string; identifier: string }[]) {
      const list = map.get(row.pr_key) ?? []
      list.push(row.identifier)
      map.set(row.pr_key, list)
    }
    return map
  }

  function decorate(
    list: PullRequest[],
    tags: Map<string, string[]>,
    sessions: Map<string, CursorSession[]>,
    links: Map<string, string[]>,
  ): PullRequest[] {
    return list.map((pr) => {
      const merged = mergeLinkedIssues(pr, links.get(pr.key) ?? [])
      return {
        ...merged,
        initiativeIds: tags.get(pr.key) ?? [],
        cursorSessions: sessions.get(pr.key) ?? [],
      }
    })
  }

  function parseList(raw: string | null | undefined): PullRequest[] {
    if (!raw) return []
    return JSON.parse(raw) as PullRequest[]
  }

  function snapshot(): Snapshot {
    const row = readSnapshotRow.get() as SnapshotRow | undefined
    const tags = assignments()
    const sessions = sessionsByPull()
    const links = linearLinks()
    const held = queue.heldKeys()
    const visible = (list: PullRequest[]) => (held.size === 0 ? list : list.filter((pr) => !held.has(pr.key)))
    return {
      viewer: row?.viewer ?? null,
      syncedAt: row?.synced_at ?? null,
      mineSyncedAt: row?.mine_synced_at ?? null,
      reviewSyncedAt: row?.review_synced_at ?? null,
      repos: watchedRepos(),
      pullRequests: row ? visible(decorate(parseList(row.pull_requests), tags, sessions, links)) : [],
      reviewPullRequests: row ? visible(decorate(parseList(row.review_pull_requests), tags, sessions, links)) : [],
      initiatives: initiatives(),
      linearConfigured: row ? row.linear_configured === 1 : Boolean(process.env.LINEAR_API_KEY),
      warning: row?.warning ?? null,
    }
  }

  function watchedRepos(): string[] {
    return (db.prepare('SELECT repo FROM watched_repos ORDER BY repo').all() as { repo: string }[]).map((row) => row.repo)
  }

  function storedRepos(): string[] {
    const names = new Set<string>()
    const row = readSnapshotRow.get() as SnapshotRow | undefined
    for (const pr of [...parseList(row?.pull_requests), ...parseList(row?.review_pull_requests)]) names.add(pr.repo)
    for (const rule of db.prepare('SELECT repo FROM repo_rules').all() as { repo: string }[]) names.add(rule.repo)
    for (const session of db.prepare('SELECT pr_key FROM agent_sessions').all() as { pr_key: string }[]) {
      const repo = pullKeyRepo(session.pr_key)
      if (repo) names.add(repo)
    }
    for (const repo of queue.repos()) names.add(repo)
    return [...names].sort()
  }

  function stripStored(list: PullRequest[]): PullRequest[] {
    return list.map(({ cursorSessions: _sessions, ...pr }) => ({ ...pr, initiativeIds: [] }))
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
      const strip = stripStored
      const links = linearLinks()
      const keep = (list: PullRequest[]) => list.map((pr) => mergeLinkedIssues(pr, links.get(pr.key) ?? []))
      const existing = readSnapshotRow.get() as SnapshotRow | undefined
      const review = input.reviewPullRequests ?? parseList(existing?.review_pull_requests)
      const mineSyncedAt = input.mineSyncedAt === undefined ? (existing?.mine_synced_at ?? null) : input.mineSyncedAt
      const reviewSyncedAt = input.reviewSyncedAt === undefined ? (existing?.review_synced_at ?? null) : input.reviewSyncedAt
      db.prepare(
        `INSERT INTO snapshot (id, viewer, synced_at, mine_synced_at, review_synced_at, linear_configured, warning, pull_requests, review_pull_requests)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           viewer = excluded.viewer,
           synced_at = excluded.synced_at,
           mine_synced_at = excluded.mine_synced_at,
           review_synced_at = excluded.review_synced_at,
           linear_configured = excluded.linear_configured,
           warning = excluded.warning,
           pull_requests = excluded.pull_requests,
           review_pull_requests = excluded.review_pull_requests`,
      ).run(
        input.viewer,
        input.syncedAt,
        mineSyncedAt,
        reviewSyncedAt,
        input.linearConfigured ? 1 : 0,
        input.warning,
        JSON.stringify(strip(keep(input.pullRequests))),
        JSON.stringify(strip(keep(review))),
      )
      return snapshot()
    },
    ruleCache() {
      return (
        db.prepare('SELECT repo, checks, required_approvals, dismiss_stale, fetched_at FROM repo_rules ORDER BY repo').all() as {
          repo: string
          checks: string
          required_approvals: number
          dismiss_stale: number
          fetched_at: string
        }[]
      ).map((row) => ({
        repo: row.repo,
        checks: JSON.parse(row.checks) as string[],
        requiredApprovals: row.required_approvals,
        dismissStale: row.dismiss_stale === 1,
        fetchedAt: row.fetched_at,
      }))
    },
    saveRules(repo, rules, fetchedAt) {
      db.prepare(
        `INSERT INTO repo_rules (repo, checks, required_approvals, dismiss_stale, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET
           checks = excluded.checks,
           required_approvals = excluded.required_approvals,
           dismiss_stale = excluded.dismiss_stale,
           fetched_at = excluded.fetched_at`,
      ).run(repo, JSON.stringify(rules.checks), rules.requiredApprovals, rules.dismissStale ? 1 : 0, fetchedAt)
    },
    watchedRepos,
    watchRepo(repo) {
      db.prepare('INSERT INTO watched_repos (repo, created_at) VALUES (?, ?) ON CONFLICT(repo) DO NOTHING').run(
        repo,
        new Date().toISOString(),
      )
    },
    storedRepos,
    forgetRepo(repo) {
      if (queue.repoActive(repo)) {
        const error = new Error(`A merge is in progress for ${repo}. Cancel it before removing the repository.`)
        error.name = 'RepoBusy'
        throw error
      }
      const like = repoKeyLike(repo)
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      db.exec('BEGIN')
      try {
        queue.forgetRepo(repo)
        db.prepare('DELETE FROM repo_rules WHERE repo = ?').run(repo)
        db.prepare(`DELETE FROM agent_sessions WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare(`DELETE FROM initiative_pull_requests WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare(`DELETE FROM linear_links WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare('DELETE FROM watched_repos WHERE repo = ?').run(repo)
        if (row) {
          const mine = stripStored(parseList(row.pull_requests).filter((pr) => pr.repo !== repo))
          const review = stripStored(parseList(row.review_pull_requests).filter((pr) => pr.repo !== repo))
          db.prepare('UPDATE snapshot SET pull_requests = ?, review_pull_requests = ? WHERE id = 1').run(
            JSON.stringify(mine),
            JSON.stringify(review),
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
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
      writeCursorSession.run(
        session.agentId,
        prKey,
        session.kind,
        session.prompt,
        session.runId,
        session.status,
        session.result,
        session.branch,
        session.createdAt,
        session.updatedAt,
      )
    },
    queue,
    patchFeedback(key, counts) {
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      if (!row) return
      const apply = (list: PullRequest[]) => list.map((pr) => (pr.key === key ? { ...pr, ...counts } : pr))
      const strip = (list: PullRequest[]) => list.map((pr) => ({ ...pr, initiativeIds: [] }))
      db.prepare('UPDATE snapshot SET pull_requests = ?, review_pull_requests = ? WHERE id = 1').run(
        JSON.stringify(strip(apply(parseList(row.pull_requests)))),
        JSON.stringify(strip(apply(parseList(row.review_pull_requests)))),
      )
    },
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
    linearLinks,
    attachLinearIssue(prKey, issue) {
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      if (!row) throw new Error('Refresh pull requests before linking an issue.')
      const stored = { ...issue, identifier: issue.identifier.toUpperCase() }
      let found = false
      const add = (list: PullRequest[]) =>
        list.map((pr) => {
          if (pr.key !== prKey) return pr
          found = true
          const issues = pr.linearIssues ?? []
          const index = issues.findIndex((item) => item.identifier.toUpperCase() === stored.identifier)
          const linearIssues =
            index === -1 ? [...issues, stored] : issues.map((item, position) => (position === index ? { ...item, ...stored } : item))
          return { ...pr, linearIssues }
        })
      const pullRequests = add(parseList(row.pull_requests))
      const reviewPullRequests = add(parseList(row.review_pull_requests))
      if (!found) throw new Error('That pull request is no longer in this list.')
      const strip = (list: PullRequest[]) => list.map((pr) => ({ ...pr, initiativeIds: [] }))
      db.exec('BEGIN')
      try {
        db.prepare('INSERT INTO linear_links (pr_key, identifier) VALUES (?, ?) ON CONFLICT DO NOTHING').run(prKey, stored.identifier)
        db.prepare('UPDATE snapshot SET pull_requests = ?, review_pull_requests = ? WHERE id = 1').run(
          JSON.stringify(strip(pullRequests)),
          JSON.stringify(strip(reviewPullRequests)),
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return snapshot()
    },
  }
}
