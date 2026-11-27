import type { DatabaseSync } from 'node:sqlite'
import type { ActivityEvent } from '../shared/activity.ts'
import type { PullRequest } from '../shared/types.ts'

/**
 * One step for each change to the tables. A database records how many steps it has had and is given the rest,
 * in order, when it is opened. A change to a table is a new step at the end; a step that has shipped is never edited.
 */
const STEPS: ((db: DatabaseSync) => void)[] = [baseline]

export function migrate(db: DatabaseSync) {
  const { user_version: done } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let step = done; step < STEPS.length; step += 1) {
    db.exec('BEGIN')
    try {
      STEPS[step]!(db)
      db.exec(`PRAGMA user_version = ${step + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

type Reviewed = Pick<PullRequest, 'key' | 'repo' | 'repoName' | 'number' | 'title' | 'url' | 'viewerReviewedAt' | 'readyAt'>

/** Writes a pull request's review to the log, once for each time it was reviewed. One that was never reviewed is skipped. */
export function reviewLogger(db: DatabaseSync): (pr: Reviewed) => void {
  const write = db.prepare('INSERT OR IGNORE INTO review_log (pr_key, at, pull_request) VALUES (?, ?, ?)')
  return (pr) => {
    if (!pr.viewerReviewedAt) return
    const event: ActivityEvent = {
      key: pr.key,
      repo: pr.repo,
      repoName: pr.repoName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      at: pr.viewerReviewedAt,
      readyAt: pr.readyAt ?? null,
    }
    write.run(pr.key, pr.viewerReviewedAt, JSON.stringify(event))
  }
}

/**
 * The tables as they stood when steps were first counted. A database older than that may be at any earlier
 * shape, so this step alone looks at what is there and adds what is missing. Later steps know what they follow.
 */
function baseline(db: DatabaseSync) {
  const hadReviewLog = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_log'").get() != null
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
    CREATE TABLE IF NOT EXISTS repo_marks (
      repo TEXT PRIMARY KEY,
      icon TEXT NOT NULL,
      color TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS agent_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_provider TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo_agents (
      repo TEXT PRIMARY KEY,
      provider TEXT,
      environment_id TEXT,
      checkout TEXT
    );
    CREATE TABLE IF NOT EXISTS departed_pulls (
      pr_key TEXT PRIMARY KEY,
      list TEXT NOT NULL,
      outcome TEXT NOT NULL,
      at TEXT NOT NULL,
      pull_request TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_log (
      pr_key TEXT NOT NULL,
      at TEXT NOT NULL,
      pull_request TEXT NOT NULL,
      PRIMARY KEY (pr_key, at)
    );
    CREATE TABLE IF NOT EXISTS local_resolutions (
      item_id TEXT PRIMARY KEY,
      pr_key TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linear_links (
      pr_key TEXT NOT NULL,
      identifier TEXT NOT NULL,
      PRIMARY KEY (pr_key, identifier)
    );
  `)

  const legacySessions = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursor_sessions'").get()
  if (legacySessions) {
    db.exec(`
      INSERT OR IGNORE INTO agent_sessions (agent_id, pr_key, kind, prompt, run_id, status, result, branch, created_at, updated_at)
      SELECT agent_id, pr_key, 'conflict', NULL, run_id, status, result, branch, updated_at, updated_at FROM cursor_sessions;
      DROP TABLE cursor_sessions;
    `)
  }

  const sessionColumns = db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]
  if (!sessionColumns.some((column) => column.name === 'provider')) {
    db.exec(`
      ALTER TABLE agent_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'cursor';
      ALTER TABLE agent_sessions ADD COLUMN environment_id TEXT;
      ALTER TABLE agent_sessions ADD COLUMN url TEXT;
      ALTER TABLE agent_sessions ADD COLUMN unreachable_since TEXT;
    `)
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

  // What was known before the review log existed is the one review each stored pull request carries.
  if (!hadReviewLog) {
    const logReview = reviewLogger(db)
    const gone = db.prepare(`SELECT pull_request FROM departed_pulls WHERE list = 'review' AND outcome <> 'pending'`).all() as { pull_request: string }[]
    for (const row of gone) logReview(JSON.parse(row.pull_request) as Reviewed)
    const stored = db.prepare('SELECT review_pull_requests FROM snapshot WHERE id = 1').get() as { review_pull_requests: string | null } | undefined
    for (const pr of JSON.parse(stored?.review_pull_requests || '[]') as PullRequest[]) logReview(pr)
  }

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
      base_oid TEXT,
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
    DROP TABLE IF EXISTS merge_watches;
  `)

  const stepColumns = db.prepare('PRAGMA table_info(merge_steps)').all() as { name: string }[]
  if (!stepColumns.some((column) => column.name === 'base_oid')) {
    // Steps queued before this column existed were rebased after every merge, so each sits on its parent's recorded head.
    db.exec(`
      ALTER TABLE merge_steps ADD COLUMN base_oid TEXT;
      UPDATE merge_steps SET base_oid = (
        SELECT parent.head_oid FROM merge_steps AS parent
        WHERE parent.entry_id = merge_steps.entry_id AND parent.head_ref = merge_steps.base_ref AND parent.id != merge_steps.id
      )
      WHERE status NOT IN ('merged', 'restacked', 'cancelled');
    `)
  }
}
