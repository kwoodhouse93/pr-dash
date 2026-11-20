import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentKindLabel, agentWork } from '../shared/agents.ts'
import { cursorLinks, cursorSessionActive, cursorStatusLabel } from '../shared/cursor.ts'
import type { CursorSession, PullRequest } from '../shared/types.ts'
import { formatExact, formatWhen } from './format.ts'
import { Markdown } from './markdown.tsx'
import { prHref, usePrLinkHost } from './pr-links.tsx'

export type AgentItem = { pr: PullRequest; session: CursorSession }

function cursorStatusDetail(session: CursorSession): string {
  switch (session.status) {
    case 'creating':
      return 'Cursor is starting a cloud agent.'
    case 'running':
      return agentWork(session.kind)
    case 'finished':
      return 'Cursor finished this run.'
    case 'failed':
      return 'Cursor reported a failed run.'
    case 'cancelled':
      return 'This Cursor run was cancelled.'
    case 'expired':
      return 'This Cursor run expired.'
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
export function agentGist(session: CursorSession): string {
  return (session.result && firstLine(session.result)) || (session.prompt && firstLine(session.prompt)) || cursorStatusDetail(session)
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
          {agentKindLabel(session.kind)} · <span className={`agent-status ${session.status}`}>{cursorStatusLabel(session.status)}</span>
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
    <div className="agent-list">
      <h3>Cursor agents</h3>
      {items.map((item) => (
        <button key={item.session.agentId} type="button" className="agent-row" onClick={() => onOpen(item.session.agentId)}>
          <Summary item={item} showPr={showPr} />
        </button>
      ))}
      <button type="button" className="agent-all" onClick={() => onOpen(null)}>
        Open all
      </button>
    </div>
  )
}

const TALLY: { label: string; tone: CursorSession['status']; statuses: CursorSession['status'][] }[] = [
  { label: 'running', tone: 'running', statuses: ['creating', 'running'] },
  { label: 'finished', tone: 'finished', statuses: ['finished'] },
  { label: 'failed', tone: 'failed', statuses: ['failed'] },
  { label: 'stopped', tone: 'cancelled', statuses: ['cancelled', 'expired'] },
]

function startOpen(items: AgentItem[], focus: string | null): Set<string> {
  if (focus) return new Set([focus])
  const active = items.filter((item) => cursorSessionActive(item.session.status)).map((item) => item.session.agentId)
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
      className="drawer-back"
      onMouseDown={(event) => {
        event.stopPropagation()
        scrimPress.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (scrimPress.current && event.target === event.currentTarget) onClose()
      }}
    >
      <aside className="drawer agent-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-head">
          <div>
            <p className="eyebrow" id={titleId}>Cursor agents</p>
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
          <button type="button" className="popover-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="drawer-body">
          {items.map((item) => (
            <Section key={item.session.agentId} item={item} showPr={!single} open={open.has(item.session.agentId)} onToggle={() => toggle(item.session.agentId)} />
          ))}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function Section({ item, showPr, open, onToggle }: { item: AgentItem; showPr: boolean; open: boolean; onToggle: () => void }) {
  const { session } = item
  const bodyId = useId()
  const links = cursorLinks(session.agentId)
  return (
    <section className="agent-section" data-open={open || undefined}>
      <button type="button" className="agent-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <Summary item={item} showPr={showPr} />
      </button>
      {open ? (
        <div className="agent-detail" id={bodyId}>
          {session.prompt ? <p className="agent-prompt">{session.prompt}</p> : null}
          <p className="agent-meta">
            {cursorStatusDetail(session)} <span title={formatExact(session.createdAt)}>Started {startedWhen(session.createdAt)}.</span>
            {session.branch ? (
              <>
                {' '}
                Pushed to <code>{session.branch}</code>.
              </>
            ) : null}
          </p>
          {session.result ? <Markdown className="cursor-result agent-reply" text={session.result} /> : null}
          <div className="agent-links">
            <a className="external" href={links.desktopUrl}>
              Open in Cursor
            </a>
            <a className="external" href={links.webUrl} target="_blank" rel="noreferrer">
              Open on the web
            </a>
          </div>
        </div>
      ) : null}
    </section>
  )
}
