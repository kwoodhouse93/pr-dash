import { AGENT_PROVIDERS, environmentFor, providerFor, type AgentRequest, type AgentChecks, type T3Environment } from '../shared/agents.ts'
import { buildStacks, restackChain, stackOf } from '../shared/stacks.ts'
import type { AgentProviderId, AgentSession, PullRequest } from '../shared/types.ts'
import { AgentUnavailable, type AgentProvider } from './agent-provider.ts'
import { agentTask } from './agent-tasks.ts'
import { cursorProvider } from './cursor.ts'
import type { DashboardDb } from './db.ts'
import { Refused } from './errors.ts'
import { t3Origin } from './t3-home.ts'
import { t3ConnectedUntil } from './t3-mcp.ts'
import { checkoutProblem, shortFolder, t3Environments, t3Provider, t3ProjectsByRepo, t3RemoteProjects, type T3Project } from './t3.ts'

export const agentProviders: Record<AgentProviderId, AgentProvider> = {
  cursor: cursorProvider,
  t3: t3Provider,
}

/** The chosen provider could not be used. `fallback` is another that is ready now. */
export class AgentLaunchUnavailable extends Refused {
  readonly provider: AgentProviderId
  readonly fallback: AgentProviderId | null

  constructor(message: string, provider: AgentProviderId, fallback: AgentProviderId | null) {
    super(message, 503)
    this.provider = provider
    this.fallback = fallback
  }

  override get detail() {
    return { provider: this.provider, fallback: this.fallback }
  }
}

/**
 * Starts an agent with the repository's provider, or with `override` for this one launch.
 * Another provider is only ever offered, never used unasked: it can cost money and run somewhere else.
 */
export async function launchAgent(db: DashboardDb, pr: PullRequest, request: AgentRequest, override: AgentProviderId | null): Promise<AgentSession> {
  const id = override ?? providerFor(db.agentRouting(), pr.repo)
  const repo = db.repoAgents().get(pr.repo)
  try {
    const environmentId = id === 't3' ? environmentFor(db.defaultEnvironment(), repo?.environmentId ?? null) : null
    // On this machine a folder set by hand wins. Without one, T3 Code's own project for the repository is used.
    // Another environment finds its own project for the repository.
    const checkout = environmentId ? null : (repo?.checkout ?? (id === 't3' ? ((await t3ProjectsByRepo()).get(pr.repo.toLowerCase())?.root ?? null) : null))
    const session = await agentProviders[id].start({
      pr,
      request,
      task: agentTask(pr, request, request.kind === 'conflict' ? upstackOf(db, pr) : []),
      target: { environmentId, checkout },
    })
    db.saveAgentSession(pr.key, session)
    return session
  } catch (error) {
    if (!(error instanceof AgentUnavailable)) throw error
    throw new AgentLaunchUnavailable(error.message, id, await readyOtherThan(id))
  }
}

/** Every open pull request stacked above this one on its own list, each after the one it is based on. */
function upstackOf(db: DashboardDb, pr: PullRequest): PullRequest[] {
  const snap = db.snapshot()
  const list = [snap.pullRequests, snap.reviewPullRequests].find((prs) => prs.some((item) => item.key === pr.key))
  const stack = list ? stackOf(buildStacks(list), pr.key) : null
  return (stack ? restackChain(stack, pr.key) : null)?.slice(1) ?? []
}

async function readyOtherThan(id: AgentProviderId): Promise<AgentProviderId | null> {
  for (const { id: other } of AGENT_PROVIDERS) {
    if (other === id) continue
    const health = await agentProviders[other].health().catch(() => null)
    if (health?.state === 'ready') return other
  }
  return null
}

/** Asks each provider whether it is ready, and T3 Code what it is linked to and which project it has for each repository. */
export async function agentChecks(db: DashboardDb): Promise<AgentChecks> {
  const agents = db.repoAgents()
  const fallback = db.defaultEnvironment()
  const [projects, environments] = await Promise.all([
    t3ProjectsByRepo().catch(() => new Map<string, T3Project>()),
    t3Environments().catch((): T3Environment[] => []),
  ])
  const connectedUntil = t3ConnectedUntil()
  // The projects of each environment a repository runs in. One that cannot be asked reads as having none.
  const inUse = new Set(db.watchedRepos().flatMap((repo) => environmentFor(fallback, agents.get(repo)?.environmentId ?? null) ?? []))
  const remote = new Map<string, Map<string, T3Project>>()
  if (connectedUntil) {
    await Promise.all(
      [...inUse]
        .filter((id) => environments.some((environment) => environment.id === id && environment.reachable))
        .map(async (id) => {
          const found = await t3RemoteProjects(id).catch(() => null)
          if (found) remote.set(id, found)
        }),
    )
  }
  const [providers, repos] = await Promise.all([
    Promise.all(
      AGENT_PROVIDERS.map(async ({ id }) => ({
        id,
        health: await agentProviders[id]
          .health()
          .catch((error) => ({ state: 'unreachable' as const, detail: error instanceof Error ? error.message : String(error) })),
      })),
    ),
    Promise.all(
      db.watchedRepos().map(async (repo) => {
        const agent = agents.get(repo)
        const checkout = agent?.checkout ?? null
        const environmentId = environmentFor(fallback, agent?.environmentId ?? null)
        const there = environmentId ? remote.get(environmentId)?.get(repo.toLowerCase()) : null
        const here = projects.get(repo.toLowerCase())
        const check = {
          environmentId,
          project: environmentId
            ? there
              ? { title: there.title, folder: there.root }
              : null
            : here
              ? { title: here.title, folder: shortFolder(here.root) }
              : null,
          checkout,
          checkoutProblem: checkout && !environmentId ? await checkoutProblem(repo, checkout).catch(() => null) : null,
        }
        return [repo, check] as const
      }),
    ),
  ])
  return { t3Origin: t3Origin(), providers, t3: { connectedUntil, environments }, repos: Object.fromEntries(repos) }
}
