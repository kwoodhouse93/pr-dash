import { useEffect, useState } from 'react'
import type { LinearAssignee, LinearIssue, LinearStatus } from '../shared/types.ts'
import { api } from './api.ts'
import { ClickCard, useMenuClose } from './menus.tsx'

const ISSUE_ID = /^[A-Z][A-Z0-9]+-\d+$/

export function isLinearIdentifier(value: string): boolean {
  return ISSUE_ID.test(value)
}

export function IssueControls({
  menuKey,
  issue,
  onUpdate,
}: {
  menuKey: string
  issue: LinearIssue
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
        label={
          <>
            <span className="sr">{statusName}</span>
            <StatusIcon type={issue.status?.type ?? 'unstarted'} color={issue.status?.color ?? '#706c63'} label={statusName} />
          </>
        }
      >
        <StatusMenu issue={issue} onUpdate={onUpdate} />
      </ClickCard>
      <ClickCard
        id={`assignee:${menuKey}`}
        className="assignee-hit"
        panelClassName="picker-panel"
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

function StatusMenu({
  issue,
  onUpdate,
}: {
  issue: LinearIssue
  onUpdate: (identifier: string, patch: { statusId?: string }) => Promise<void>
}) {
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
    <div className="picker" role="listbox" aria-label="Issue status">
      <h3>Status</h3>
      {error ? <p>{error}</p> : null}
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
    </div>
  )
}

function AssigneeMenu({
  issue,
  onUpdate,
}: {
  issue: LinearIssue
  onUpdate: (identifier: string, patch: { assigneeId: string | null }) => Promise<void>
}) {
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
    <div className="picker" role="listbox" aria-label="Assignee">
      <h3>Assignee</h3>
      <input
        className="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people"
        aria-label="Search people"
        autoFocus
      />
      {error ? <p>{error}</p> : null}
      {users === null && !error ? <p>Loading people…</p> : null}
      <button
        type="button"
        className="option"
        role="option"
        aria-selected={!issue.assignee}
        disabled={busy}
        onClick={() => void choose(null)}
      >
        <AssigneeFace user={null} />
        <span>Unassigned</span>
      </button>
      {currentMissing && issue.assignee ? (
        <button
          type="button"
          className="option"
          role="option"
          aria-selected
          disabled={busy}
          onClick={() => void choose(issue.assignee!.id)}
        >
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
    </div>
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
          <path d="M5 8.15 7.05 10.2 11.1 6" fill="none" stroke="#141512" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
    <span className="avatar empty" aria-hidden="true">
      <svg viewBox="0 0 16 16">
        <circle cx="8" cy="5.2" r="2" fill="currentColor" />
        <path d="M3.8 12.6c.55-2.15 2-3.2 4.2-3.2s3.65 1.05 4.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  )
}
