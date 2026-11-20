import { AGENT_PROVIDERS, providerFor, type AgentRequest, type AgentSettings } from '../shared/agents.ts'
import type { AgentProviderId, AgentSession, PullRequest } from '../shared/types.ts'
import { AgentUnavailable, type AgentProvider } from './agent-provider.ts'
import { agentTask } from './agent-tasks.ts'
import { cursorProvider } from './cursor.ts'
import type { DashboardDb } from './db.ts'
import { checkoutProblem, t3Provider } from './t3.ts'

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
    const session = await agentProviders[id].start({
      pr,
      request,
      task: agentTask(pr, request),
      target: { environmentId: repo?.environmentId ?? null, checkout: repo?.checkout ?? null },
    })
    db.saveAgentSession(pr.key, session)
    return session
  } catch (error) {
    if (!(error instanceof AgentUnavailable)) throw error
    throw new AgentLaunchUnavailable(error.message, id, await readyOtherThan(id))
  }
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
        return {
          repo,
          provider: agent?.provider ?? null,
          checkout,
          checkoutProblem: checkout ? await checkoutProblem(repo, checkout).catch(() => null) : null,
        }
      }),
    ),
  ])
  return { defaultProvider: routing.defaultProvider, providers, repos }
}
