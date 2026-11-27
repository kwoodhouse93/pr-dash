import { createContext, useContext, useState, type ReactNode } from 'react'
import { agentKindLabel, agentWork, DEFAULT_ROUTING, providerFor, providerLabel, sessionLinks, startingTabUrl, t3ThreadUrl, type AgentRequest } from '../shared/agents.ts'
import { pullKeyRepo } from '../shared/repos.ts'
import type { AgentProviderId, AgentRouting, AgentSession } from '../shared/types.ts'
import { paintCursorLoading } from './cursor-loading.ts'
import { flyParcel, markCaught, type Box } from './flight.ts'
import { AGENTS_BUTTON, pressBox, sendOff } from './send-off.ts'
import { landed, whoosh } from './sounds.ts'
import { toastError, toastSuccess } from './toasts.tsx'

/** `provider` starts this one agent somewhere other than the repository's usual place. */
export type StartAgent = (key: string, request: AgentRequest, provider?: AgentProviderId) => Promise<{ url: string | null }>

type Agents = { start: StartAgent; routing: AgentRouting; t3Origin: string | null }

const AgentContext = createContext<Agents>({
  start: () => Promise.reject(new Error('Agents are not available here.')),
  routing: DEFAULT_ROUTING,
  t3Origin: null,
})

export function AgentProvider({
  start,
  routing = DEFAULT_ROUTING,
  t3Origin = null,
  children,
}: {
  start: StartAgent
  routing?: AgentRouting
  /** The T3 Code this browser is paired with. With it, a T3 Code thread opens in a tab. */
  t3Origin?: string | null
  children: ReactNode
}) {
  return <AgentContext.Provider value={{ start, routing, t3Origin }}>{children}</AgentContext.Provider>
}

/** Where a session opens from this browser. */
export function useSessionLinks(session: Pick<AgentSession, 'provider' | 'agentId' | 'url'>): ReturnType<typeof sessionLinks> {
  return sessionLinks(session, useContext(AgentContext).t3Origin)
}

/** The name of whatever starts agents for a pull request's repository: Cursor, T3 Code. */
export function useAgentName(repo: string | null): string {
  return providerLabel(providerFor(useContext(AgentContext).routing, repo))
}

export function launchTag(key: string, request: AgentRequest): string {
  return `${key}:${request.kind}`
}

/**
 * Shows the task leaving for the agents button. `away` says a tab took the reader elsewhere, so there is
 * nobody to show it to: the button is marked when they come back instead.
 */
function sendOffToAgents(from: Box | null, label: string, away: boolean) {
  if (!away) return void sendOff(AGENTS_BUTTON, from, label)
  // The new tab is in front by the time this page is next seen.
  const onBack = () => {
    if (document.visibilityState !== 'visible') return
    document.removeEventListener('visibilitychange', onBack)
    markCaught(document.querySelector(AGENTS_BUTTON))
  }
  document.addEventListener('visibilitychange', onBack)
}

/**
 * In the desktop app the agents are listed in the window's strip and sidebar, which is another page under
 * this one. The window says where there the task lands, in this page's measure, and when to start, and
 * this page plays its part of the flight: the folding, and the way to its own edge.
 */
function sendOffToWindow(from: Box | null, label: string) {
  if (!from) return
  const onFlight = (event: Event) => {
    stop()
    const { to, at } = ((event as CustomEvent).detail ?? {}) as { to?: Box | null; at?: number }
    // The sound is this page's to make. The window's own page only draws.
    void flyParcel({ layer: document.body, from, label, to: () => to ?? null, at: typeof at === 'number' ? at : undefined, onTakeoff: whoosh }).then((arrived) => {
      if (arrived) landed()
    })
  }
  const stop = () => {
    window.clearTimeout(timer)
    window.removeEventListener('pr-dash:flight', onFlight)
  }
  // The window answers at once. One that never does is not left to take a later flight for this one.
  const timer = window.setTimeout(stop, 2000)
  window.addEventListener('pr-dash:flight', onFlight)
}

type AgentLaunch = {
  /** Resolves true once the agent has started. For Cursor, that is once its tab is showing the session. */
  launch: (pr: { key: string }, request: AgentRequest) => Promise<boolean>
  pending: string | null
  error: string | null
}

export function useAgentLaunch(): AgentLaunch {
  const { start, routing, t3Origin } = useContext(AgentContext)
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
    // A T3 Code thread has a page to open only when this browser is paired with T3 Code.
    // Otherwise it is followed from the Agents column.
    const opensTab = provider === 'cursor' || t3Origin !== null
    // The desktop app reads from the tab's address which pull request the agent is for, and lists the tab with its agents from the start.
    const desktop = (window as { prDashDesktop?: unknown }).prDashDesktop === true
    const from = pressBox()
    const agent = opensTab ? window.open(desktop ? startingTabUrl(pr.key, request, from) : '', '_blank') : null
    // In the desktop app the task flies to the window's own list of agents, which the tab is filed in. Here it flies to the agents button.
    if (desktop && agent) sendOffToWindow(from, agentKindLabel(request.kind))
    else sendOffToAgents(from, agentKindLabel(request.kind), agent !== null)
    if (agent && provider === 'cursor') {
      try {
        paintCursorLoading(agent, agentWork(request.kind, provider))
      } catch {
        // The tab still redirects when the session URL is ready.
      }
    }
    try {
      const result = await start(pr.key, request, override)
      const url = provider === 't3' ? t3ThreadUrl(t3Origin, result.url) : result.url
      if (!opensTab || !url) {
        agent?.close()
        toastSuccess(`Started in ${name}. Follow it in the Agents column.`)
        return true
      }
      if (!agent) {
        setError(`${name} started, but the new tab was blocked. Open the session from the Agents column.`)
        return false
      }
      agent.location.replace(url)
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
