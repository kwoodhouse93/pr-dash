import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentKindLabel, agentWork, providerLabel, sessionActive, sessionStatusLabel } from '../shared/agents.ts'
import type { AgentSession, PullRequest } from '../shared/types.ts'
import { useSessionLinks } from './agent-launch.tsx'
import { formatExact, formatWhen } from './format.ts'
import { Markdown } from './markdown.tsx'
import { prHref, usePrLinkHost } from './pr-links.tsx'
import { toastError, toastSuccess } from './toasts.tsx'
import { CloseButton, PopBody, PopHead } from './menus.tsx'
import { Fold, useClosing } from './motion.tsx'
import { dismiss } from './sounds.ts'

export type AgentItem = { pr: PullRequest; session: AgentSession }

function statusDetail(session: AgentSession): string {
  const name = providerLabel(session.provider)
  switch (session.status) {
    case 'creating':
      return session.provider === 'cursor' ? 'Cursor is starting a cloud agent.' : `${name} is starting a thread.`
    case 'running':
      return agentWork(session.kind, session.provider)
    case 'waiting':
      return `${name} is waiting for an answer. Open the session to reply.`
    case 'finished':
      return `${name} finished this run.`
    case 'failed':
      return `${name} reported a failed run.`
    case 'cancelled':
      return `This ${name} run was cancelled.`
    case 'expired':
      return session.provider === 'cursor' ? 'This Cursor run expired.' : `This thread is no longer in ${name}.`
  }
}

/** The first line of prose in some Markdown, without its markup. */
function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*`]|~~/g, '')
      .trim()
    if (line && !/^[-=_]{3,}$/.test(line)) return line
  }
  return ''
}

/** One line that says what a session is about: its reply once it has one, then its prompt, then its status. */
export function agentGist(session: AgentSession): string {
  return (session.result && firstLine(session.result)) || (session.prompt && firstLine(session.prompt)) || statusDetail(session)
}

function startedWhen(iso: string): string {
  const when = formatWhen(iso)
  return /^\d+[mhd]$/.test(when) ? `${when} ago` : when
}

function Summary({ item, showPr }: { item: AgentItem; showPr: boolean }) {
  const { pr, session } = item
  return (
    <>
      <i className={`agent-dot ${session.status}`} aria-hidden="true" />
      <span className="agent-sum">
        <span className="agent-title">
          {showPr ? `#${pr.number} · ` : ''}
          {agentKindLabel(session.kind)} · <span className={`agent-status ${session.status}`}>{sessionStatusLabel(session.status)}</span>
        </span>
        <span className="agent-gist">{agentGist(session)}</span>
      </span>
      <span className="agent-age" title={formatExact(session.createdAt)}>
        {formatWhen(session.createdAt)}
      </span>
      <i className="agent-chev" aria-hidden="true" />
    </>
  )
}

/** The popover: one line for each session. A line opens the sidebar at that session. */
export function AgentList({ items, showPr, onOpen }: { items: AgentItem[]; showPr: boolean; onOpen: (agentId: string | null) => void }) {
  return (
    <>
      <PopHead title="Agents" />
      <PopBody list className="agent-list">
        {items.map((item) => (
          <button key={item.session.agentId} type="button" className="agent-row" onClick={() => onOpen(item.session.agentId)}>
            <Summary item={item} showPr={showPr} />
          </button>
        ))}
        {items.length > 1 ? (
          <button type="button" className="agent-all" onClick={() => onOpen(null)}>
            Open all
          </button>
        ) : null}
      </PopBody>
    </>
  )
}

const TALLY: { label: string; tone: AgentSession['status']; statuses: AgentSession['status'][] }[] = [
  { label: 'waiting', tone: 'waiting', statuses: ['waiting'] },
  { label: 'running', tone: 'running', statuses: ['creating', 'running'] },
  { label: 'finished', tone: 'finished', statuses: ['finished'] },
  { label: 'failed', tone: 'failed', statuses: ['failed'] },
  { label: 'stopped', tone: 'cancelled', statuses: ['cancelled', 'expired'] },
]

function startOpen(items: AgentItem[], focus: string | null): Set<string> {
  if (focus) return new Set([focus])
  const active = items.filter((item) => sessionActive(item.session.status)).map((item) => item.session.agentId)
  if (active.length > 0) return new Set(active)
  return new Set(items.slice(0, 1).map((item) => item.session.agentId))
}

/**
 * The sidebar: a section for each session with its prompt, reply, and links.
 * `focus` is the session to open first. Without one, the active sessions open, or the newest when none is active.
 */
export function AgentDrawer({ prs, items, focus, onClose }: { prs: PullRequest[]; items: AgentItem[]; focus: string | null; onClose: () => void }) {
  const [open, setOpen] = useState(() => startOpen(items, focus))
  const scrimPress = useRef(false)
  const titleId = useId()
  const host = usePrLinkHost()
  const single = prs.length === 1 ? prs[0]! : null
  const [closing, close] = useClosing(onClose, 170)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A popup over the drawer closes first.
      if (event.key !== 'Escape' || document.querySelector('.popover')) return
      event.stopPropagation()
      dismiss()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  function toggle(agentId: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(agentId)) next.add(agentId)
      return next
    })
  }

  const tally = TALLY.map((group) => ({ ...group, count: items.filter((item) => group.statuses.includes(item.session.status)).length })).filter(
    (group) => group.count > 0,
  )
  return createPortal(
    <div
      className={`drawer-back${closing ? ' closing' : ''}`}
      onMouseDown={(event) => {
        event.stopPropagation()
        scrimPress.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!scrimPress.current || event.target !== event.currentTarget) return
        dismiss()
        close()
      }}
    >
      <aside className="drawer agent-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow" id={titleId}>
              Agents
            </p>
            {single ? (
              <a className="drawer-pr external" href={prHref(single.url, host)} target="_blank" rel="noreferrer">
                #{single.number} {single.title}
              </a>
            ) : (
              <p className="drawer-pr">{prs.length} pull requests</p>
            )}
            {items.length > 1 ? (
              <p className="agent-tally">
                {tally.map((group) => (
                  <span key={group.label} className={`agent-status ${group.tone}`}>
                    {group.count} {group.label}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
          <CloseButton onClose={close} />
        </header>
        <div className="drawer-body">
          {items.map((item) => (
            <Section
              key={item.session.agentId}
              item={item}
              showPr={!single}
              open={open.has(item.session.agentId)}
              onToggle={() => toggle(item.session.agentId)}
            />
          ))}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/** Every agent session of these pull requests, newest first. A pull request in two lists is counted once. */
export function agentItems(prs: PullRequest[]): AgentItem[] {
  const seen = new Set<string>()
  return prs
    .flatMap((pr) => (pr.agentSessions ?? []).map((session) => ({ pr, session })))
    .filter(({ pr, session }) => {
      const id = `${pr.key}:${session.provider}:${session.agentId}`
      return !seen.has(id) && seen.add(id)
    })
    .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
}

const GROUPS: { title: string; statuses: AgentSession['status'][] }[] = [
  { title: 'Waiting for you', statuses: ['waiting'] },
  { title: 'Running', statuses: ['creating', 'running'] },
  { title: 'Failed', statuses: ['failed'] },
  { title: 'Finished', statuses: ['finished', 'cancelled', 'expired'] },
]

/** The page: every agent session on the lists, the ones that need an answer first. A line opens to its prompt, reply and links. */
export function AgentsPage({ items }: { items: AgentItem[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  if (items.length === 0) {
    return (
      <div className="queue-page agents-page">
        <div className="empty">
          <h2>No agents yet</h2>
          <p>Start one from a pull request: fix its checks, resolve a conflict, answer a review thread, or ask for anything else.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="queue-page agents-page">
      {GROUPS.map((group) => {
        const listed = items.filter((item) => group.statuses.includes(item.session.status))
        if (listed.length === 0) return null
        return (
          <section key={group.title}>
            <h2 className="queue-repo-head">
              {group.title}
              <span className="queue-repo-sum">{listed.length}</span>
            </h2>
            {listed.map((item) => {
              const id = `${item.pr.key}:${item.session.provider}:${item.session.agentId}`
              return <Section key={id} item={item} showPr open={open.has(id)} onToggle={() => toggle(id)} />
            })}
          </section>
        )
      })}
    </div>
  )
}

async function copyReply(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toastSuccess('Copied the reply')
  } catch {
    toastError('Could not copy to the clipboard')
  }
}

function Section({ item, showPr, open, onToggle }: { item: AgentItem; showPr: boolean; open: boolean; onToggle: () => void }) {
  const { session } = item
  const bodyId = useId()
  const links = useSessionLinks(session)
  const host = usePrLinkHost()
  const name = providerLabel(session.provider)
  return (
    <section className="agent-section" data-open={open || undefined}>
      <button type="button" className="agent-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <Summary item={item} showPr={showPr} />
      </button>
      <Fold open={open}>
        <div className="agent-detail" id={bodyId}>
          {showPr ? (
            <p className="agent-meta">
              <a className="external" href={prHref(item.pr.url, host)} target="_blank" rel="noreferrer">
                #{item.pr.number} {item.pr.title}
              </a>
            </p>
          ) : null}
          {session.prompt ? <p className="agent-prompt">{session.prompt}</p> : null}
          <p className="agent-meta">
            {statusDetail(session)} <span title={formatExact(session.createdAt)}>Started {startedWhen(session.createdAt)}.</span>
            {session.branch ? (
              <>
                {' '}
                Pushed to <code>{session.branch}</code>.
              </>
            ) : null}
          </p>
          {session.unreachableSince ? (
            <p className="agent-meta agent-unreachable" title={formatExact(session.unreachableSince)}>
              {name} has not answered since {formatWhen(session.unreachableSince)}, so this status may be out of date.
            </p>
          ) : null}
          {session.result ? <Markdown className="cursor-result agent-reply" text={session.result} /> : null}
          <div className="agent-links">
            {links.appUrl ? (
              // A web address that hands off to the app opens in a tab. An app link goes straight to the app.
              <a className="external" href={links.appUrl} {...(/^https?:/.test(links.appUrl) ? { target: '_blank', rel: 'noreferrer' } : {})}>
                Open in {name}
              </a>
            ) : null}
            {links.webUrl ? (
              <a className="external" href={links.webUrl} target="_blank" rel="noreferrer">
                {links.appUrl ? 'Open here' : `Open in ${name}`}
              </a>
            ) : null}
            {session.result ? (
              <button type="button" onClick={() => void copyReply(session.result ?? '')}>
                Copy reply
              </button>
            ) : null}
          </div>
        </div>
      </Fold>
    </section>
  )
}
