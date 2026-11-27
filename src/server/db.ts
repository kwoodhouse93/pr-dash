import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_ROUTING, isAgentProvider } from '../shared/agents.ts'
import type { FeedbackCounts, LocalResolutions } from '../shared/feedback.ts'
import { pullKeyRepo, repoKeyLike } from '../shared/repos.ts'
import { ciLevel, selectChecks } from '../shared/ci.ts'
import { mergeLinkedIssues } from '../shared/linear.ts'
import type { Activity, ActivityEvent } from '../shared/activity.ts'
import type {
  AgentProviderId,
  AgentRouting,
  AgentSession,
  DepartedPull,
  Initiative,
  LinearIssue,
  PullRequest,
  RepoMark,
  Snapshot,
  ListName,
} from '../shared/types.ts'
import { pullGone, Refused } from './errors.ts'
import { attachQueue, type QueueStore } from './queue-store.ts'
import { migrate, reviewLogger } from './schema.ts'

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
  setRepoMark(repo: string, mark: RepoMark): void
  forgetRepo(repo: string): void
  createInitiative(name: string): Initiative
  renameInitiative(id: string, name: string): Initiative
  deleteInitiative(id: string): void
  setAssignments(initiativeId: string, prKeys: string[], action: 'add' | 'remove'): void
  updateLinearIssue(identifier: string, patch: LinearIssue): Snapshot
  linearLinks(): Map<string, string[]>
  attachLinearIssue(prKey: string, issue: LinearIssue): Snapshot
  patchFeedback(key: string, counts: FeedbackCounts & { feedbackAt?: string | null }): void
  /** Conversation comments and review messages the viewer resolved on this dashboard only, by GitHub node ID, with when. */
  localResolutions(): LocalResolutions
  /** A null time takes the resolution back. */
  setLocalResolution(prKey: string, itemId: string, at: string | null): void
  saveAgentSession(prKey: string, session: AgentSession): void
  agentSessions(): { prKey: string; session: AgentSession }[]
  agentRouting(): AgentRouting
  setDefaultProvider(provider: AgentProviderId): void
  /** The T3 Code environment threads start in unless a repository says otherwise. Null is this machine. */
  defaultEnvironment(): string | null
  setDefaultEnvironment(environmentId: string | null): void
  /** What each repository has set for agents. A repository with nothing set is left out. */
  repoAgents(): Map<string, RepoAgent>
  setRepoAgent(repo: string, agent: RepoAgent): void
  /** Pull requests that left the lists and are not yet known to have merged or closed. */
  pendingDepartures(): { key: string; repo: string; number: number }[]
  /** Records what GitHub says became of one. Open means it left the lists for another reason, so it is forgotten. */
  resolveDeparture(key: string, outcome: 'merged' | 'closed' | 'open', at: string | null): void
  /** Every merge of the viewer's own and every review they submitted that the dashboard has on record, oldest first. */
  activity(): Activity
  queue: QueueStore
}

export type RepoAgent = {
  /** Null follows the default. */
  provider: AgentProviderId | null
  /** The T3 Code environment to run in: one's id, `LOCAL_ENVIRONMENT` for this machine, or null to follow the default. */
  environmentId: string | null
  /** The repository's folder on this machine, for a thread that runs here. */
  checkout: string | null
}

type StoredDeparture = Pick<DepartedPull, 'key' | 'repo' | 'repoName' | 'number' | 'title' | 'url' | 'author' | 'linearIssues' | 'viewerReviewedAt' | 'readyAt'>
type Lists = { mine: PullRequest[]; review: PullRequest[] }

/** How far back the snapshot carries merged and closed pull requests. The table keeps them all. */
const DEPARTED_SHOWN_MS = 30 * 24 * 60 * 60 * 1000
const PENDING_KEPT_MS = 7 * 24 * 60 * 60 * 1000

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

/** Where the database file is. What else the server keeps on disk goes in the same folder. */
export function databasePath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'pr-dash.sqlite')
}

export function openDatabase(file = databasePath()): DashboardDb {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  // A review is logged as a refresh sees it.
  const logReview = reviewLogger(db)

  const queue = attachQueue(db, {
    // The merge queue knows a merge landed before a refresh notices the pull request has gone.
    onMerged(prKey) {
      const row = readSnapshotRow.get() as SnapshotRow | undefined
      for (const [list, raw] of [
        ['mine', row?.pull_requests],
        ['review', row?.review_pull_requests],
      ] as const) {
        const pr = parseList(raw).find((item) => item.key === prKey)
        if (!pr) continue
        writeDeparture.run(prKey, list, 'merged', new Date().toISOString(), JSON.stringify(slimDeparted(pr)))
        return
      }
    },
  })
  const readSnapshotRow = db.prepare(
    'SELECT viewer, synced_at, mine_synced_at, review_synced_at, linear_configured, warning, pull_requests, review_pull_requests FROM snapshot WHERE id = 1',
  )
  // A merge the queue made is certain, so it replaces a guess; nothing replaces a merge.
  const writeDeparture = db.prepare(
    `INSERT INTO departed_pulls (pr_key, list, outcome, at, pull_request) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pr_key) DO UPDATE SET outcome = excluded.outcome, at = excluded.at WHERE departed_pulls.outcome <> 'merged'`,
  )
  const readInitiatives = db.prepare('SELECT id, name, created_at, updated_at FROM initiatives ORDER BY created_at ASC')
  const readAssignments = db.prepare('SELECT initiative_id, pr_key FROM initiative_pull_requests')
  const readAgentSessions = db.prepare(
    `SELECT agent_id, pr_key, provider, kind, prompt, run_id, status, result, branch, environment_id, url, unreachable_since, created_at, updated_at
     FROM agent_sessions ORDER BY created_at DESC, rowid DESC`,
  )
  const writeAgentSession = db.prepare(
    `INSERT INTO agent_sessions (agent_id, pr_key, provider, kind, prompt, run_id, status, result, branch, environment_id, url, unreachable_since, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       run_id = excluded.run_id,
       status = excluded.status,
       result = excluded.result,
       branch = excluded.branch,
       url = excluded.url,
       unreachable_since = excluded.unreachable_since,
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

  function agentSessions(): { prKey: string; session: AgentSession }[] {
    return (
      readAgentSessions.all() as {
        agent_id: string
        pr_key: string
        provider: AgentProviderId
        kind: AgentSession['kind']
        prompt: string | null
        run_id: string
        status: AgentSession['status']
        result: string | null
        branch: string | null
        environment_id: string | null
        url: string | null
        unreachable_since: string | null
        created_at: string
        updated_at: string
      }[]
    ).map((row) => ({
      prKey: row.pr_key,
      session: {
        provider: row.provider,
        agentId: row.agent_id,
        runId: row.run_id,
        kind: row.kind,
        prompt: row.prompt,
        status: row.status,
        result: row.result,
        branch: row.branch,
        environmentId: row.environment_id,
        url: row.url,
        unreachableSince: row.unreachable_since,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }))
  }

  function repoAgents(): Map<string, RepoAgent> {
    const rows = db.prepare('SELECT repo, provider, environment_id, checkout FROM repo_agents').all() as {
      repo: string
      provider: string | null
      environment_id: string | null
      checkout: string | null
    }[]
    return new Map(
      rows.map((row) => [
        row.repo,
        { provider: isAgentProvider(row.provider) ? row.provider : null, environmentId: row.environment_id, checkout: row.checkout },
      ]),
    )
  }

  function agentRouting(): AgentRouting {
    const row = db.prepare('SELECT default_provider FROM agent_settings WHERE id = 1').get() as { default_provider: string } | undefined
    const repos: AgentRouting['repos'] = {}
    for (const [repo, agent] of repoAgents()) if (agent.provider) repos[repo] = agent.provider
    return { defaultProvider: isAgentProvider(row?.default_provider) ? row.default_provider : DEFAULT_ROUTING.defaultProvider, repos }
  }

  function sessionsByPull(): Map<string, AgentSession[]> {
    const map = new Map<string, AgentSession[]>()
    for (const { prKey, session } of agentSessions()) {
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

  function decorate(list: PullRequest[], tags: Map<string, string[]>, sessions: Map<string, AgentSession[]>, links: Map<string, string[]>): PullRequest[] {
    return list.map((pr) => {
      const merged = mergeLinkedIssues(pr, links.get(pr.key) ?? [])
      const checks = Array.isArray(pr.checks) ? selectChecks(pr.checks) : pr.checks
      return {
        ...merged,
        checks,
        ci: Array.isArray(checks) ? ciLevel(checks) : pr.ci,
        initiativeIds: tags.get(pr.key) ?? [],
        agentSessions: sessions.get(pr.key) ?? [],
      }
    })
  }

  function slimDeparted(pr: PullRequest): StoredDeparture {
    return {
      key: pr.key,
      repo: pr.repo,
      repoName: pr.repoName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      linearIssues: pr.linearIssues,
      viewerReviewedAt: pr.viewerReviewedAt ?? null,
      readyAt: pr.readyAt ?? null,
    }
  }

  /**
   * A pull request that was on a list and is not on either now has gone somewhere. It waits as pending
   * until GitHub says whether it merged, since leaving a list can also mean it closed or stopped asking for a review.
   */
  function noteDepartures(before: Lists, after: Lists) {
    const still = new Set([...after.mine, ...after.review].map((pr) => pr.key))
    const watched = new Set(watchedRepos())
    const now = new Date().toISOString()
    const add = db.prepare(`INSERT OR IGNORE INTO departed_pulls (pr_key, list, outcome, at, pull_request) VALUES (?, ?, 'pending', ?, ?)`)
    for (const [list, prs] of [
      ['mine', before.mine],
      ['review', before.review],
    ] as const) {
      for (const pr of prs) {
        if (!still.has(pr.key) && watched.has(pr.repo)) add.run(pr.key, list, now, JSON.stringify(slimDeparted(pr)))
      }
    }
    // One that is listed again is open again. A merge the queue made stays listed until a refresh drops it.
    const held = queue.heldKeys()
    for (const row of db.prepare('SELECT pr_key FROM departed_pulls').all() as { pr_key: string }[]) {
      if (still.has(row.pr_key) && !held.has(row.pr_key)) db.prepare('DELETE FROM departed_pulls WHERE pr_key = ?').run(row.pr_key)
    }
  }

  function departed(tags: Map<string, string[]>, sessions: Map<string, AgentSession[]>): DepartedPull[] {
    const since = new Date(Date.now() - DEPARTED_SHOWN_MS).toISOString()
    const rows = db
      .prepare(`SELECT pr_key, list, outcome, at, pull_request FROM departed_pulls WHERE outcome <> 'pending' AND at >= ? ORDER BY at DESC`)
      .all(since) as { pr_key: string; list: ListName; outcome: 'merged' | 'closed'; at: string; pull_request: string }[]
    return rows.map((row) => ({
      ...(JSON.parse(row.pull_request) as StoredDeparture),
      list: row.list,
      outcome: row.outcome,
      at: row.at,
      initiativeIds: tags.get(row.pr_key) ?? [],
      agentSessions: sessions.get(row.pr_key) ?? [],
    }))
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
      repoMarks: repoMarks(),
      agents: agentRouting(),
      pullRequests: row ? visible(decorate(parseList(row.pull_requests), tags, sessions, links)) : [],
      reviewPullRequests: row ? visible(decorate(parseList(row.review_pull_requests), tags, sessions, links)) : [],
      departed: departed(tags, sessions),
      initiatives: initiatives(),
      linearConfigured: row ? row.linear_configured === 1 : Boolean(process.env.LINEAR_API_KEY),
      warning: row?.warning ?? null,
    }
  }

  function watchedRepos(): string[] {
    return (db.prepare('SELECT repo FROM watched_repos ORDER BY repo').all() as { repo: string }[]).map((row) => row.repo)
  }

  function repoMarks(): Record<string, RepoMark> {
    const rows = db.prepare('SELECT repo, icon, color FROM repo_marks').all() as { repo: string; icon: string; color: string }[]
    return Object.fromEntries(rows.map((row) => [row.repo, { icon: row.icon, color: row.color }]))
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
    return list.map(({ agentSessions: _sessions, ...pr }) => ({ ...pr, initiativeIds: [] }))
  }

  function assertUniqueName(name: string, ignoreId?: string) {
    const existing = db.prepare('SELECT id FROM initiatives WHERE lower(name) = lower(?)').get(name) as { id: string } | undefined
    if (existing && existing.id !== ignoreId) {
      throw new Refused(`An initiative named "${name}" already exists.`, 409)
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
      noteDepartures({ mine: parseList(existing?.pull_requests), review: parseList(existing?.review_pull_requests) }, { mine: input.pullRequests, review })
      const watched = new Set(watchedRepos())
      for (const pr of review) {
        if (watched.has(pr.repo)) logReview(pr)
      }
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
      db.prepare('INSERT INTO watched_repos (repo, created_at) VALUES (?, ?) ON CONFLICT(repo) DO NOTHING').run(repo, new Date().toISOString())
    },
    storedRepos,
    setRepoMark(repo, mark) {
      db.prepare(
        'INSERT INTO repo_marks (repo, icon, color) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET icon = excluded.icon, color = excluded.color',
      ).run(repo, mark.icon, mark.color)
    },
    forgetRepo(repo) {
      if (queue.repoActive(repo)) {
        throw new Refused(`A merge is in progress for ${repo}. Cancel it before removing the repository.`, 409)
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
        db.prepare(`DELETE FROM local_resolutions WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare(`DELETE FROM departed_pulls WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare(`DELETE FROM review_log WHERE pr_key LIKE ? ESCAPE '\\'`).run(like)
        db.prepare('DELETE FROM watched_repos WHERE repo = ?').run(repo)
        db.prepare('DELETE FROM repo_marks WHERE repo = ?').run(repo)
        db.prepare('DELETE FROM repo_agents WHERE repo = ?').run(repo)
        if (row) {
          const mine = stripStored(parseList(row.pull_requests).filter((pr) => pr.repo !== repo))
          const review = stripStored(parseList(row.review_pull_requests).filter((pr) => pr.repo !== repo))
          db.prepare('UPDATE snapshot SET pull_requests = ?, review_pull_requests = ? WHERE id = 1').run(JSON.stringify(mine), JSON.stringify(review))
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    createInitiative(name) {
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 80) throw new Refused('Initiative name must be 1–80 characters.')
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
      if (!trimmed || trimmed.length > 80) throw new Refused('Initiative name must be 1–80 characters.')
      assertUniqueName(trimmed, id)
      const now = new Date().toISOString()
      const result = db.prepare('UPDATE initiatives SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id)
      if (Number(result.changes) === 0) throw new Refused('Initiative not found.', 404)
      return { id, name: trimmed, createdAt: now, updatedAt: now }
    },
    deleteInitiative(id) {
      db.prepare('DELETE FROM initiatives WHERE id = ?').run(id)
    },
    setAssignments(initiativeId, prKeys, action) {
      const found = db.prepare('SELECT id FROM initiatives WHERE id = ?').get(initiativeId)
      if (!found) throw new Refused('Initiative not found.', 404)
      const now = new Date().toISOString()
      const insert = db.prepare('INSERT INTO initiative_pull_requests (initiative_id, pr_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
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
    pendingDepartures() {
      // One GitHub never answered for is not worth asking about for ever.
      db.prepare(`DELETE FROM departed_pulls WHERE outcome = 'pending' AND at < ?`).run(new Date(Date.now() - PENDING_KEPT_MS).toISOString())
      const rows = db.prepare(`SELECT pr_key, pull_request FROM departed_pulls WHERE outcome = 'pending'`).all() as { pr_key: string; pull_request: string }[]
      return rows.map((row) => {
        const pr = JSON.parse(row.pull_request) as StoredDeparture
        return { key: row.pr_key, repo: pr.repo, number: pr.number }
      })
    },
    resolveDeparture(key, outcome, at) {
      if (outcome === 'open') db.prepare(`DELETE FROM departed_pulls WHERE pr_key = ? AND outcome = 'pending'`).run(key)
      else
        db.prepare(`UPDATE departed_pulls SET outcome = ?, at = ? WHERE pr_key = ? AND outcome = 'pending'`).run(outcome, at ?? new Date().toISOString(), key)
    },
    activity() {
      const merges = db.prepare(`SELECT at, pull_request FROM departed_pulls WHERE list = 'mine' AND outcome = 'merged' ORDER BY at ASC`).all() as {
        at: string
        pull_request: string
      }[]
      const reviews = db.prepare('SELECT pull_request FROM review_log ORDER BY at ASC').all() as { pull_request: string }[]
      return {
        merged: merges.map((row) => {
          const pr = JSON.parse(row.pull_request) as StoredDeparture
          return { key: pr.key, repo: pr.repo, repoName: pr.repoName, number: pr.number, title: pr.title, url: pr.url, at: row.at, readyAt: pr.readyAt ?? null }
        }),
        reviewed: reviews.map((row) => JSON.parse(row.pull_request) as ActivityEvent),
      }
    },
    agentSessions,
    saveAgentSession(prKey, session) {
      writeAgentSession.run(
        session.agentId,
        prKey,
        session.provider,
        session.kind,
        session.prompt,
        session.runId,
        session.status,
        session.result,
        session.branch,
        session.environmentId,
        session.url,
        session.unreachableSince,
        session.createdAt,
        session.updatedAt,
      )
    },
    agentRouting,
    setDefaultProvider(provider) {
      db.prepare(
        'INSERT INTO agent_settings (id, default_provider) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET default_provider = excluded.default_provider',
      ).run(provider)
    },
    defaultEnvironment() {
      const row = db.prepare('SELECT default_environment_id FROM agent_settings WHERE id = 1').get() as { default_environment_id: string | null } | undefined
      return row?.default_environment_id ?? null
    },
    setDefaultEnvironment(environmentId) {
      db.prepare(
        `INSERT INTO agent_settings (id, default_provider, default_environment_id) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET default_environment_id = excluded.default_environment_id`,
      ).run(DEFAULT_ROUTING.defaultProvider, environmentId)
    },
    repoAgents,
    setRepoAgent(repo, agent) {
      if (!agent.provider && !agent.environmentId && !agent.checkout) {
        db.prepare('DELETE FROM repo_agents WHERE repo = ?').run(repo)
        return
      }
      db.prepare(
        `INSERT INTO repo_agents (repo, provider, environment_id, checkout) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET provider = excluded.provider, environment_id = excluded.environment_id, checkout = excluded.checkout`,
      ).run(repo, agent.provider, agent.environmentId, agent.checkout)
    },
    queue,
    localResolutions() {
      const rows = db.prepare('SELECT item_id, at FROM local_resolutions').all() as { item_id: string; at: string }[]
      return Object.fromEntries(rows.map((row) => [row.item_id, row.at]))
    },
    setLocalResolution(prKey, itemId, at) {
      if (at === null) {
        db.prepare('DELETE FROM local_resolutions WHERE item_id = ?').run(itemId)
        return
      }
      db.prepare(
        'INSERT INTO local_resolutions (item_id, pr_key, at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET pr_key = excluded.pr_key, at = excluded.at',
      ).run(itemId, prKey, at)
    },
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
          const linearIssues = index === -1 ? [...issues, stored] : issues.map((item, position) => (position === index ? { ...item, ...stored } : item))
          return { ...pr, linearIssues }
        })
      const pullRequests = add(parseList(row.pull_requests))
      const reviewPullRequests = add(parseList(row.review_pull_requests))
      if (!found) throw pullGone()
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
