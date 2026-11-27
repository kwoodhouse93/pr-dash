import { useEffect, useState } from 'react'
import { isLinearIdentifier } from '../shared/linear.ts'
import type { LinearAssignee, LinearIssue, LinearStatus, PullRequest } from '../shared/types.ts'
import { api } from './api.ts'
import { ClickCard, PopBody, PopHead, useMenuClose } from './menus.tsx'
import { Icon } from './icons.tsx'

export { isLinearIdentifier }

export function IssueControls({
  menuKey,
  issue,
  disabled = false,
  onUpdate,
}: {
  menuKey: string
  issue: LinearIssue
  disabled?: boolean
  onUpdate: (identifier: string, patch: { statusId?: string; assigneeId?: string | null }) => Promise<void>
}) {
  const statusName = issue.status?.name ?? 'Set status'
  const assigneeName = issue.assignee?.name ?? 'Unassigned'
  return (
    <span className="issue-controls">
      <ClickCard
        id={`status:${menuKey}`}
        className="status-hit"
        panelClassName="picker-panel"
        disabled={disabled}
        label={
          <>
            <span className="sr">{statusName}</span>
            <StatusIcon type={issue.status?.type ?? 'unstarted'} color={issue.status?.color ?? ''} label={statusName} />
          </>
        }
      >
        <StatusMenu issue={issue} onUpdate={onUpdate} />
      </ClickCard>
      <ClickCard
        id={`assignee:${menuKey}`}
        className="assignee-hit"
        panelClassName="picker-panel"
        disabled={disabled}
        label={
          <>
            <span className="sr">{assigneeName}</span>
            <AssigneeFace user={issue.assignee ?? null} />
          </>
        }
      >
        <AssigneeMenu issue={issue} onUpdate={onUpdate} />
      </ClickCard>
    </span>
  )
}

type IssueMatch = { identifier: string; title: string | null; url: string | null }

export function LinkIssueForm({
  prs,
  initialKey,
  onLink,
  onBack,
}: {
  prs: PullRequest[]
  initialKey: string
  onLink: (key: string, identifier: string) => Promise<void>
  /** Shown as a step of a menu, this returns to the menu. */
  onBack?: () => void
}) {
  const close = useMenuClose()
  const [key, setKey] = useState(prs.some((pr) => pr.key === initialKey) ? initialKey : prs[0]!.key)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<IssueMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pr = prs.find((item) => item.key === key) ?? prs[0]!
  const linked = new Set(pr.linearIssues.map((issue) => issue.identifier.toUpperCase()))

  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) {
      setMatches([])
      setSearching(false)
      setError(null)
      return
    }
    let cancel = false
    setSearching(true)
    setError(null)
    const timer = window.setTimeout(() => {
      api
        .searchLinearIssues(term)
        .then((next) => {
          if (!cancel) setMatches(next)
        })
        .catch((caught: unknown) => {
          if (!cancel) {
            setMatches([])
            setError(caught instanceof Error ? caught.message : 'Could not search Linear')
          }
        })
        .finally(() => {
          if (!cancel) setSearching(false)
        })
    }, 200)
    return () => {
      cancel = true
      window.clearTimeout(timer)
    }
  }, [query])

  async function choose(identifier: string) {
    if (linked.has(identifier) || busy) return
    setBusy(true)
    setError(null)
    try {
      await onLink(pr.key, identifier)
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not link that issue')
    } finally {
      setBusy(false)
    }
  }

  const typed = query.trim().toUpperCase()
  const typedId = isLinearIdentifier(typed) ? typed : null
  const shown = typedId && !matches.some((issue) => issue.identifier === typedId) ? [{ identifier: typedId, title: null, url: null }, ...matches] : matches

  return (
    <form
      className="link-issue pop-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (typedId) void choose(typedId)
      }}
    >
      <PopHead title="Link Linear issue" sub={`Attaches #${pr.number} on the issue`} onBack={onBack} />
      <PopBody list className="picker">
        {prs.length > 1 ? (
          <label className="agent-target">
            Pull request
            <select className="select" value={key} disabled={busy} onChange={(event) => setKey(event.target.value)}>
              {prs.map((item) => (
                <option key={item.key} value={item.key}>
                  #{item.number} {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ENG-123 or a title"
          aria-label="Find a Linear issue"
          autoFocus
          disabled={busy}
        />
        {error ? <p className="launch-error">{error}</p> : null}
        {searching ? <p>Searching…</p> : null}
        {shown.map((issue) => {
          const already = linked.has(issue.identifier)
          return (
            <button key={issue.identifier} type="button" className="option" disabled={busy || already} onClick={() => void choose(issue.identifier)}>
              <span>
                {issue.identifier}
                {issue.title ? ` · ${issue.title}` : ''}
                {already ? ' · Already linked' : ''}
              </span>
            </button>
          )
        })}
        {!searching && query.trim().length >= 2 && shown.length === 0 && !error ? <p>No matching issues.</p> : null}
      </PopBody>
    </form>
  )
}

function StatusMenu({ issue, onUpdate }: { issue: LinearIssue; onUpdate: (identifier: string, patch: { statusId?: string }) => Promise<void> }) {
  const close = useMenuClose()
  const [statuses, setStatuses] = useState<LinearStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancel = false
    api
      .linearStatuses({ teamId: issue.teamId, issue: issue.identifier })
      .then((next) => {
        if (!cancel) setStatuses(next)
      })
      .catch((caught) => {
        if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not load statuses')
      })
    return () => {
      cancel = true
    }
  }, [issue.identifier, issue.teamId])

  async function choose(statusId: string) {
    if (statusId === issue.status?.id) {
      close()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onUpdate(issue.identifier, { statusId })
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the status')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PopHead title={`Status · ${issue.identifier}`} />
      <PopBody list className="picker" role="listbox" label="Issue status">
        {error ? <p className="launch-error">{error}</p> : null}
        {statuses === null && !error ? <p>Loading statuses…</p> : null}
        {statuses?.map((status) => (
          <button
            key={status.id}
            type="button"
            className="option"
            role="option"
            aria-selected={status.id === issue.status?.id}
            disabled={busy}
            onClick={() => void choose(status.id)}
          >
            <StatusIcon type={status.type} color={status.color} label={status.name} />
            <span>{status.name}</span>
          </button>
        ))}
      </PopBody>
    </>
  )
}

function AssigneeMenu({ issue, onUpdate }: { issue: LinearIssue; onUpdate: (identifier: string, patch: { assigneeId: string | null }) => Promise<void> }) {
  const close = useMenuClose()
  const [users, setUsers] = useState<LinearAssignee[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancel = false
    api
      .linearUsers()
      .then((next) => {
        if (!cancel) setUsers(next)
      })
      .catch((caught) => {
        if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not load people')
      })
    return () => {
      cancel = true
    }
  }, [])

  async function choose(assigneeId: string | null) {
    if (assigneeId === (issue.assignee?.id ?? null)) {
      close()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onUpdate(issue.identifier, { assigneeId })
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the assignee')
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const visible = (users ?? []).filter((user) => !needle || user.name.toLowerCase().includes(needle))
  const currentMissing = issue.assignee && !visible.some((user) => user.id === issue.assignee?.id) && !needle

  return (
    <>
      <PopHead title={`Assignee · ${issue.identifier}`} />
      <PopBody list className="picker" role="listbox" label="Assignee">
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          autoFocus
        />
        {error ? <p className="launch-error">{error}</p> : null}
        {users === null && !error ? <p>Loading people…</p> : null}
        <button type="button" className="option" role="option" aria-selected={!issue.assignee} disabled={busy} onClick={() => void choose(null)}>
          <AssigneeFace user={null} />
          <span>Unassigned</span>
        </button>
        {currentMissing && issue.assignee ? (
          <button type="button" className="option" role="option" aria-selected disabled={busy} onClick={() => void choose(issue.assignee!.id)}>
            <AssigneeFace user={issue.assignee} />
            <span>{issue.assignee.name}</span>
          </button>
        ) : null}
        {visible.map((user) => (
          <button
            key={user.id}
            type="button"
            className="option"
            role="option"
            aria-selected={user.id === issue.assignee?.id}
            disabled={busy}
            onClick={() => void choose(user.id)}
          >
            <AssigneeFace user={user} />
            <span>{user.name}</span>
          </button>
        ))}
        {users && visible.length === 0 ? <p>No matching people.</p> : null}
      </PopBody>
    </>
  )
}

function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : 'currentColor'
}

export function StatusIcon({ type, color, label }: { type: string; color: string; label: string }) {
  const ink = safeColor(color)
  const kind = type.toLowerCase()
  return (
    <svg className="status-icon" viewBox="0 0 16 16" aria-hidden="true">
      <title>{label}</title>
      {kind === 'completed' ? (
        <>
          <circle cx="8" cy="8" r="6" fill={ink} />
          <path d="M5 8.15 7.05 10.2 11.1 6" className="tick" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : kind === 'canceled' || kind === 'duplicate' ? (
        <>
          <circle cx="8" cy="8" r="5.4" fill="none" stroke={ink} strokeWidth="1.6" />
          <path d="M6 6 10 10 M10 6 6 10" fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : kind === 'started' ? (
        <>
          <circle cx="8" cy="8" r="5.4" fill="none" stroke={ink} strokeWidth="1.6" />
          <path d="M8 2.6a5.4 5.4 0 0 0 0 10.8Z" fill={ink} />
        </>
      ) : kind === 'backlog' ? (
        <circle cx="8" cy="8" r="5.4" fill="none" stroke={ink} strokeWidth="1.6" strokeDasharray="2 2.4" />
      ) : kind === 'triage' ? (
        <>
          <circle cx="8" cy="8" r="5.4" fill="none" stroke={ink} strokeWidth="1.6" />
          <circle cx="8" cy="8" r="2" fill={ink} />
        </>
      ) : (
        <circle cx="8" cy="8" r="5.4" fill="none" stroke={ink} strokeWidth="1.6" />
      )}
    </svg>
  )
}

function AssigneeFace({ user }: { user: LinearAssignee | null }) {
  if (user?.avatarUrl) return <img className="avatar" src={user.avatarUrl} alt="" />
  if (user) return <span className="avatar fallback">{user.name.slice(0, 1).toUpperCase()}</span>
  return (
    <span className="avatar unassigned" aria-hidden="true">
      <Icon name="unassigned" />
    </span>
  )
}
