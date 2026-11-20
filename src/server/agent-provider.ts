import { sessionActive, type AgentHealth, type AgentRequest } from '../shared/agents.ts'
import type { AgentProviderId, AgentSession, PullRequest } from '../shared/types.ts'
import type { AgentTask } from './agent-tasks.ts'

/** Where a provider runs an agent for a repository. Cursor ignores it. */
export type AgentTarget = {
  /** The T3 Code environment to run in. Null is this machine, the only one supported so far. */
  environmentId: string | null
  /** The repository's folder in that environment. */
  checkout: string | null
}

export type AgentStart = {
  pr: PullRequest
  request: AgentRequest
  task: AgentTask
  target: AgentTarget
}

export type AgentProvider = {
  id: AgentProviderId
  health(): Promise<AgentHealth>
  /** Throws `AgentUnavailable` when the provider is not set up or not answering. */
  start(input: AgentStart): Promise<AgentSession>
  /** The session as the provider has it now. Throws `AgentUnavailable` when the provider is not answering. */
  read(session: AgentSession): Promise<AgentSession>
}

/** The provider could not be used at all, as opposed to refusing or failing this one request. */
export class AgentUnavailable extends Error {
  readonly health: Exclude<AgentHealth, { state: 'ready' }>

  constructor(state: 'unconfigured' | 'unreachable', detail: string) {
    super(detail)
    this.name = 'AgentUnavailable'
    this.health = { state, detail }
  }
}

/** The fields every new session starts with. */
export function newSession(
  provider: AgentProviderId,
  input: Pick<AgentSession, 'agentId' | 'runId' | 'kind' | 'prompt' | 'status'> & Partial<Pick<AgentSession, 'environmentId' | 'url'>>,
): AgentSession {
  const now = new Date().toISOString()
  return {
    provider,
    agentId: input.agentId,
    runId: input.runId,
    kind: input.kind,
    prompt: input.prompt,
    status: input.status,
    result: null,
    branch: null,
    environmentId: input.environmentId ?? null,
    url: input.url ?? null,
    unreachableSince: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Reads every active session again. A provider that does not answer leaves the
 * session as it was and marks when it stopped answering, so a session is never
 * called failed because its provider was out of reach.
 */
export async function refreshSessions(
  providers: Record<AgentProviderId, AgentProvider>,
  sessions: { prKey: string; session: AgentSession }[],
  save: (prKey: string, session: AgentSession) => void,
): Promise<void> {
  const active = sessions.filter((item) => sessionActive(item.session.status))
  await Promise.all(
    active.map(async ({ prKey, session }) => {
      try {
        save(prKey, { ...(await providers[session.provider].read(session)), unreachableSince: null })
      } catch (error) {
        if (error instanceof AgentUnavailable && !session.unreachableSince) {
          save(prKey, { ...session, unreachableSince: new Date().toISOString() })
        }
        // Anything else keeps the last status. The next refresh tries again.
      }
    }),
  )
}
