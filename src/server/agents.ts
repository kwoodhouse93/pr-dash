import { AGENT_PROVIDERS, providerFor, type AgentRequest, type AgentSettings } from '../shared/agents.ts'
import { buildStacks, restackChain, stackOf } from '../shared/stacks.ts'
import type { AgentProviderId, AgentSession, PullRequest } from '../shared/types.ts'
import { AgentUnavailable, type AgentProvider } from './agent-provider.ts'
import { agentTask } from './agent-tasks.ts'
import { cursorProvider } from './cursor.ts'
import type { DashboardDb } from './db.ts'
import { checkoutProblem, shortFolder, t3Origin, t3Provider, t3ProjectsByRepo } from './t3.ts'

export const agentProviders: Record<AgentProviderId, AgentProvider> = {
  cursor: cursorProvider,
  t3: t3Provider,
}

/** The chosen provider could not be used. `fallback` is another that is ready now. */
export class AgentLaunchUnavailable extends Error {
  readonly provider: AgentProviderId
  readonly fallback: AgentProviderId | null

  constructor(message: string, provider: AgentProviderId, fallback: AgentProviderId | null) {
    super(message)
    this.name = 'AgentLaunchUnavailable'
    this.provider = provider
    this.fallback = fallback
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
    // A folder set by hand wins. Without one, T3 Code's own project for the repository is used.
    const checkout = repo?.checkout ?? (id === 't3' ? ((await t3ProjectsByRepo()).get(pr.repo.toLowerCase())?.root ?? null) : null)
    const session = await agentProviders[id].start({
      pr,
      request,
      task: agentTask(pr, request, request.kind === 'conflict' ? upstackOf(db, pr) : []),
      target: { environmentId: repo?.environmentId ?? null, checkout },
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

export async function agentSettings(db: DashboardDb): Promise<AgentSettings> {
  const routing = db.agentRouting()
  const agents = db.repoAgents()
  const projects = await t3ProjectsByRepo().catch(() => new Map())
  const [providers, repos] = await Promise.all([
    Promise.all(
      AGENT_PROVIDERS.map(async ({ id }) => ({
        id,
        health: await agentProviders[id].health().catch((error) => ({ state: 'unreachable' as const, detail: error instanceof Error ? error.message : String(error) })),
      })),
    ),
    Promise.all(
      db.watchedRepos().map(async (repo) => {
        const agent = agents.get(repo)
        const checkout = agent?.checkout ?? null
        const project = projects.get(repo.toLowerCase())
        return {
          repo,
          provider: agent?.provider ?? null,
          project: project ? { title: project.title, folder: shortFolder(project.root) } : null,
          checkout,
          checkoutProblem: checkout ? await checkoutProblem(repo, checkout).catch(() => null) : null,
        }
      }),
    ),
  ])
  return { defaultProvider: routing.defaultProvider, t3Origin: t3Origin(), providers, repos }
}
