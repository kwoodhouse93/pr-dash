import { createContext, useContext, useState, type ReactNode } from 'react'
import { agentWork, DEFAULT_ROUTING, providerFor, providerLabel, type AgentRequest } from '../shared/agents.ts'
import { pullKeyRepo } from '../shared/repos.ts'
import type { AgentProviderId, AgentRouting } from '../shared/types.ts'
import { paintCursorLoading } from './cursor-loading.ts'
import { toastError, toastSuccess } from './toasts.tsx'

/** `provider` starts this one agent somewhere other than the repository's usual place. */
export type StartAgent = (key: string, request: AgentRequest, provider?: AgentProviderId) => Promise<{ url: string | null }>

type Agents = { start: StartAgent; routing: AgentRouting }

const AgentContext = createContext<Agents>({
  start: () => Promise.reject(new Error('Agents are not available here.')),
  routing: DEFAULT_ROUTING,
})

export function AgentProvider({ start, routing = DEFAULT_ROUTING, children }: { start: StartAgent; routing?: AgentRouting; children: ReactNode }) {
  return <AgentContext.Provider value={{ start, routing }}>{children}</AgentContext.Provider>
}

/** The name of whatever starts agents for a pull request's repository: Cursor, T3 Code. */
export function useAgentName(repo: string | null): string {
  return providerLabel(providerFor(useContext(AgentContext).routing, repo))
}

export function launchTag(key: string, request: AgentRequest): string {
  return `${key}:${request.kind}`
}

type AgentLaunch = {
  /** Resolves true once the agent has started. For Cursor, that is once its tab is showing the session. */
  launch: (pr: { key: string }, request: AgentRequest) => Promise<boolean>
  pending: string | null
  error: string | null
}

/** A provider with a page worth opening the moment an agent starts. A T3 Code thread is followed from the Agents column. */
function opensTab(provider: AgentProviderId): boolean {
  return provider === 'cursor'
}

export function useAgentLaunch(): AgentLaunch {
  const { start, routing } = useContext(AgentContext)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function launch(pr: { key: string }, request: AgentRequest, override?: AgentProviderId): Promise<boolean> {
    const provider = override ?? providerFor(routing, pullKeyRepo(pr.key))
    const name = providerLabel(provider)
    setError(null)
    setPending(launchTag(pr.key, request))
    // Open during the click so the browser allows the tab. Paint the loading
    // page before any await, while this document can still write to it. Leave
    // opener set until the session URL is assigned; clearing it first keeps
    // this tab and opens the session in a second one.
    const agent = opensTab(provider) ? window.open('', '_blank') : null
    if (agent) {
      try {
        paintCursorLoading(agent, agentWork(request.kind, provider))
      } catch {
        // The tab still redirects when the session URL is ready.
      }
    }
    try {
      const result = await start(pr.key, request, override)
      if (!opensTab(provider) || !result.url) {
        agent?.close()
        toastSuccess(`Started in ${name}. Follow it in the Agents column.`)
        return true
      }
      if (!agent) {
        setError(`${name} started, but the new tab was blocked. Open the session from the Agents column.`)
        return false
      }
      agent.location.replace(result.url)
      try {
        agent.opener = null
      } catch {
        // Navigation can make the tab cross-origin before this runs.
      }
      return true
    } catch (caught) {
      agent?.close()
      const message = caught instanceof Error ? caught.message : `Could not start ${name}.`
      setError(message)
      // The provider is not set up or not answering. Another one is offered, never used
      // unasked: it can cost money and run somewhere else. The button is a click of its
      // own, so that provider's tab is allowed to open.
      const fallback = (caught as { body?: { fallback?: unknown } }).body?.fallback
      if (!override && (fallback === 'cursor' || fallback === 't3')) {
        toastError(message, {
          heading: `Could not start ${name}`,
          onRetry: () => void launch(pr, request, fallback),
          retryLabel: `Use ${providerLabel(fallback)} instead`,
        })
      }
      return false
    } finally {
      setPending(null)
    }
  }

  return { launch, pending, error }
}
