import { createContext, useContext, useState, type ReactNode } from 'react'
import { agentWork, type AgentRequest } from '../shared/agents.ts'
import { paintCursorLoading } from './cursor-loading.ts'

export type StartAgent = (key: string, request: AgentRequest) => Promise<{ url: string }>

const AgentContext = createContext<StartAgent>(() => Promise.reject(new Error('Cursor agents are not available here.')))

export function AgentProvider({ start, children }: { start: StartAgent; children: ReactNode }) {
  return <AgentContext.Provider value={start}>{children}</AgentContext.Provider>
}

export function launchTag(key: string, request: AgentRequest): string {
  return `${key}:${request.kind}`
}

type AgentLaunch = {
  /** Resolves true once the agent's tab is showing its session. */
  launch: (pr: { key: string }, request: AgentRequest) => Promise<boolean>
  pending: string | null
  error: string | null
}

export function useAgentLaunch(): AgentLaunch {
  const start = useContext(AgentContext)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function launch(pr: { key: string }, request: AgentRequest): Promise<boolean> {
    setError(null)
    setPending(launchTag(pr.key, request))
    // Open during the click so the browser allows the tab. Paint the loading
    // page before any await, while this document can still write to it. Leave
    // opener set until the session URL is assigned; clearing it first keeps
    // this tab and opens the session in a second one.
    const agent = window.open('', '_blank')
    if (agent) {
      try {
        paintCursorLoading(agent, agentWork(request.kind))
      } catch {
        // The tab still redirects when the session URL is ready.
      }
    }
    try {
      const result = await start(pr.key, request)
      if (!agent) {
        setError('Cursor started, but the new tab was blocked. Open the session from the Agents column.')
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
      setError(caught instanceof Error ? caught.message : 'Could not start Cursor.')
      return false
    } finally {
      setPending(null)
    }
  }

  return { launch, pending, error }
}
