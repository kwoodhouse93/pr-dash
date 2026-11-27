import { useState } from 'react'
import { agentKindLabel, agentWork, leadingStatus, providerLabel, sessionActive, sessionStatusLabel } from '../../shared/agents.ts'
import type { AgentSession, PullRequest } from '../../shared/types.ts'
import { useSessionLinks } from '../agent-launch.tsx'
import { AgentDrawer, AgentList } from '../agents.tsx'
import { ClickCard, useMenuClose } from '../menus.tsx'
import { useStackLock } from './context.tsx'

export function RunningNote({ session, prefix = null }: { session: AgentSession; prefix?: string | null }) {
  const { webUrl } = useSessionLinks(session)
  return (
    <p>
      {prefix ? `${prefix} · ` : ''}
      {sessionStatusLabel(session.status)}. {agentWork(session.kind, session.provider)}{' '}
      {webUrl ? (
        <a className="external" href={webUrl} target="_blank" rel="noreferrer">
          Open session
        </a>
      ) : null}
    </p>
  )
}

export function Agents({ id, prs }: { id: string; prs: PullRequest[] }) {
  const sessions = prs
    .flatMap((pr) => (pr.agentSessions ?? []).map((session) => ({ pr, session })))
    .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
  const { locked } = useStackLock()
  const closeMenu = useMenuClose()
  const [drawer, setDrawer] = useState<{ focus: string | null } | null>(null)
  if (sessions.length === 0) {
    return (
      <td className="agents">
        <span className="sr">No agents</span>
      </td>
    )
  }
  const lead = leadingStatus(sessions.map((item) => item.session.status)) ?? 'running'
  const active = sessions.filter((item) => sessionActive(item.session.status)).length
  const only = sessions.length === 1 ? sessions[0]!.session : null
  const spoken = only
    ? `${providerLabel(only.provider)} agent, ${agentKindLabel(only.kind)}, ${sessionStatusLabel(only.status)}`
    : `${sessions.length} agents, ${active} active`
  const label = (
    <>
      <span className="sr">{spoken}</span>
      <span aria-hidden="true">{sessions.length}</span>
    </>
  )
  function open(focus: string | null) {
    closeMenu()
    setDrawer({ focus })
  }
  return (
    <td className="agents">
      <ClickCard id={id} disabled={locked} className={`cursor-chip ${lead}`} panelClassName="agent-panel" label={label}>
        <AgentList items={sessions} showPr={prs.length > 1} onOpen={open} />
      </ClickCard>
      {drawer ? <AgentDrawer prs={prs} items={sessions} focus={drawer.focus} onClose={() => setDrawer(null)} /> : null}
    </td>
  )
}
