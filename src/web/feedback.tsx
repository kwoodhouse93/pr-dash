import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PROMPT_LIMIT, type AgentRequest, type ThreadFix } from '../shared/agents.ts'
import {
  asNote,
  asThread,
  summarizeNotes,
  threadKinds,
  threadPermalink,
  type FeedbackCounts,
  type FeedbackDetail,
  type FeedbackNote,
  type FeedbackPayload,
  type FeedbackThread,
} from '../shared/feedback.ts'
import type { PullRequest } from '../shared/types.ts'
import { useAgentLaunch } from './agent-launch.tsx'
import { api } from './api.ts'
import { formatExact, formatWhen } from './format.ts'
import { Markdown } from './markdown.tsx'

export type FeedbackFocus = 'awaiting' | 'unread' | 'unresolved' | 'resolved' | 'threads' | 'comments' | 'review-comments'

export type FeedbackTarget = {
  key: string
  number: number
  title: string
  url: string
  threads: number
  unresolved: number
  awaiting: number
  unread: number
  resolvedUnread: number
  comments: number
  reviewComments: number
  truncated: boolean
  detailsPending: boolean
}

const FOCUS_TITLE: Record<FeedbackFocus, string> = {
  awaiting: 'Awaiting you',
  unread: 'Unread',
  unresolved: 'Unresolved',
  resolved: 'Resolved unread',
  threads: 'Threads',
  comments: 'Comments',
  'review-comments': 'Review comments',
}

const FOCUS_HINT: Record<FeedbackFocus, string> = {
  awaiting: 'Show threads awaiting you',
  unread: 'Show unread threads',
  unresolved: 'Show unresolved threads',
  resolved: 'Show resolved threads you have not caught up on',
  threads: 'Show review threads',
  comments: 'Show conversation comments',
  'review-comments': 'Show review comments',
}

type FeedbackApi = {
  viewer: string | null
  onCounts: (key: string, counts: FeedbackCounts) => void
}

const FeedbackContext = createContext<FeedbackApi>({ viewer: null, onCounts: () => {} })

export function FeedbackProvider({ viewer, onCounts, children }: FeedbackApi & { children: ReactNode }) {
  return <FeedbackContext.Provider value={{ viewer, onCounts }}>{children}</FeedbackContext.Provider>
}

export function feedbackTarget(pr: PullRequest): FeedbackTarget {
  return {
    key: pr.key,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    threads: pr.threadCount,
    unresolved: pr.unresolvedCount,
    awaiting: pr.awaitingYouCount ?? 0,
    unread: pr.unreadCount ?? 0,
    resolvedUnread: pr.resolvedUnreadCount ?? 0,
    comments: pr.commentAwaitingCount ?? 0,
    reviewComments: pr.reviewCommentAwaitingCount ?? 0,
    truncated: pr.threadsTruncated,
    detailsPending: pr.threadCount > 0 && pr.feedbackAt !== pr.updatedAt,
  }
}

function targetMatches(target: FeedbackTarget, focus: FeedbackFocus, mode: 'mine' | 'review'): boolean {
  switch (focus) {
    case 'awaiting':
      return target.awaiting > 0
    case 'unread':
      return target.unread > 0
    case 'unresolved':
      return target.unresolved > 0
    case 'resolved':
      return target.resolvedUnread > 0
    case 'threads':
      return target.threads > 0 || target.truncated
    case 'review-comments':
      return target.reviewComments > 0
    case 'comments':
      return mode === 'mine' ? target.comments > 0 : target.comments > target.reviewComments
  }
}

export function Feedback({ mode, targets }: { mode: 'mine' | 'review'; targets: FeedbackTarget[] }) {
  const [open, setOpen] = useState<{ focus: FeedbackFocus; targets: FeedbackTarget[] } | null>(null)
  const threads = sum(targets, (target) => target.threads)
  const unresolved = sum(targets, (target) => target.unresolved)
  const awaiting = sum(targets, (target) => target.awaiting)
  const unread = sum(targets, (target) => target.unread)
  const resolvedUnread = sum(targets, (target) => target.resolvedUnread)
  const comments = sum(targets, (target) => target.comments)
  const reviewComments = sum(targets, (target) => target.reviewComments)
  const truncated = targets.length === 1 && Boolean(targets[0]?.truncated)
  const parts: { key: string; text: string; hot: boolean; focus: FeedbackFocus }[] = []
  const commentText = (count: number) => `${count} comment${count === 1 ? '' : 's'}`
  if (mode === 'review') {
    if (unread > 0) parts.push({ key: 'unread', text: `${unread} unread`, hot: true, focus: 'unread' })
    if (reviewComments > 0) parts.push({ key: 'review-comments', text: commentText(reviewComments), hot: true, focus: 'review-comments' })
    const otherComments = comments - reviewComments
    if (reviewComments === 0 && comments > 0) parts.push({ key: 'comments', text: commentText(comments), hot: false, focus: 'comments' })
    else if (otherComments > 0) parts.push({ key: 'comments', text: `${otherComments} other`, hot: false, focus: 'comments' })
    if (resolvedUnread > 0) parts.push({ key: 'resolved', text: `${resolvedUnread} resolved unread`, hot: false, focus: 'resolved' })
  } else {
    if (awaiting > 0) parts.push({ key: 'awaiting', text: `${awaiting} awaiting`, hot: true, focus: 'awaiting' })
    if (comments > 0) parts.push({ key: 'comments', text: commentText(comments), hot: true, focus: 'comments' })
  }
  if (unresolved > 0) parts.push({ key: 'unresolved', text: `${unresolved} unresolved`, hot: true, focus: 'unresolved' })
  if (threads > 0 || parts.length === 0) {
    parts.push({ key: 'threads', text: `${threads}${truncated ? '+' : ''} thread${threads === 1 ? '' : 's'}`, hot: false, focus: 'threads' })
  }
  const pending = targets.some((target) => target.detailsPending)
  const title = `${mode === 'review'
    ? 'Unread is an open thread you joined that has a newer reply. A highlighted comment is a review message, or a conversation you joined, that you have not answered. Other comments are conversation notes you have not joined. Resolved unread is a thread you joined that was resolved, or replied to, after you last spoke.'
    : 'Awaiting you is an open thread whose latest human comment is not yours. A comment is a conversation comment or review message you have not answered.'} Unresolved threads block merge.${pending ? ' Reply details are still loading.' : ''}`
  function choose(focus: FeedbackFocus) {
    const matching = targets.filter((target) => targetMatches(target, focus, mode))
    const picked = matching.length > 0 ? matching : focus === 'threads' ? targets : matching
    setOpen({ focus, targets: picked })
  }
  return (
    <span className="feedback" title={title}>
      {parts.map((part, index) => (
        <span key={part.key}>
          {index > 0 ? <span className="dot">·</span> : null}
          <button type="button" className="feedback-hit" title={FOCUS_HINT[part.focus]} onClick={() => choose(part.focus)}>
            {part.hot ? <em className="await">{part.text}</em> : part.text}
          </button>
        </span>
      ))}
      {open ? <FeedbackDrawer focus={open.focus} targets={open.targets} onClose={() => setOpen(null)} /> : null}
    </span>
  )
}

function sum(targets: FeedbackTarget[], pick: (target: FeedbackTarget) => number): number {
  return targets.reduce((total, target) => total + pick(target), 0)
}

type Loaded = {
  target: FeedbackTarget
  detail: FeedbackDetail
  threadIds: string[]
}

function FeedbackDrawer({ focus, targets, onClose }: { focus: FeedbackFocus; targets: FeedbackTarget[]; onClose: () => void }) {
  const { viewer, onCounts } = useContext(FeedbackContext)
  const [sections, setSections] = useState<Loaded[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set())
  const notes = focus === 'comments' || focus === 'review-comments'
  const key = targets.map((target) => target.key).join('\n')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancel = false
    setSections(null)
    setError(null)
    if (targets.length === 0) {
      setSections([])
      return
    }
    Promise.all(targets.map((target) => api.pullFeedback(target.key).then((payload) => ({ target, payload }))))
      .then((loaded) => {
        if (cancel) return
        const next = loaded.map(({ target, payload }) => ({
          target,
          detail: payload.detail,
          threadIds: threadIdsFor(payload.detail, focus, viewer),
        }))
        for (const item of loaded) onCounts(item.target.key, item.payload.counts)
        setSections(next)
        if (notes && viewer) {
          const ids = next.flatMap((section) => {
            const id = unansweredId(section.detail, viewer)
            return id ? [id] : []
          })
          if (ids.length > 0) setOpenNotes(new Set(ids))
        }
      })
      .catch((caught) => {
        if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not load feedback')
      })
    return () => {
      cancel = true
    }
  }, [key, focus, viewer, notes, onCounts, targets])

  function apply(targetKey: string, payload: FeedbackPayload) {
    onCounts(targetKey, payload.counts)
    setSections((current) =>
      current?.map((section) => (section.target.key === targetKey ? { ...section, detail: payload.detail } : section)) ?? current,
    )
  }

  const single = targets.length === 1 ? targets[0] : null
  return createPortal(
    <div className="drawer-back" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow" id="feedback-title">{FOCUS_TITLE[focus]}</p>
            {single ? (
              <a className="drawer-pr" href={single.url} target="_blank" rel="noreferrer">
                #{single.number} {single.title}
              </a>
            ) : (
              <p className="drawer-pr">{targets.length} pull requests</p>
            )}
          </div>
          <button type="button" className="popover-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="drawer-body">
          {error ? <p className="launch-error">{error}</p> : null}
          {sections === null && !error ? <p className="faint">Loading feedback…</p> : null}
          {sections && sections.length === 0 ? <p className="faint">Nothing in this list.</p> : null}
          {sections?.map((section) => (
            <section key={section.target.key} className="feedback-section">
              {targets.length > 1 ? (
                <h3>
                  <a href={section.target.url} target="_blank" rel="noreferrer">
                    #{section.target.number} {section.target.title}
                  </a>
                </h3>
              ) : null}
              {notes ? (
                <NoteList
                  detail={section.detail}
                  openNotes={openNotes}
                  onOpen={(id) => setOpenNotes((current) => new Set([...current, id]))}
                  onReply={(noteId, body) => api.replyToNote(section.target.key, noteId, body).then((payload) => apply(section.target.key, payload))}
                />
              ) : (
                <ThreadList
                  prKey={section.target.key}
                  detail={section.detail}
                  threadIds={section.threadIds}
                  prUrl={section.target.url}
                  onReply={(threadId, body) => api.replyToThread(section.target.key, threadId, body).then((payload) => apply(section.target.key, payload))}
                  onResolve={(threadId, resolved) =>
                    api.setThreadResolved(section.target.key, threadId, resolved).then((payload) => apply(section.target.key, payload))
                  }
                />
              )}
            </section>
          ))}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function threadIdsFor(detail: FeedbackDetail, focus: FeedbackFocus, viewer: string | null): string[] {
  if (focus === 'comments' || focus === 'review-comments') return []
  if (focus === 'threads' || !viewer) return detail.threads.map((thread) => thread.id)
  const kind = focus === 'resolved' ? 'resolvedUnread' : focus
  return detail.threads.filter((thread) => threadKinds(asThread(thread), viewer).includes(kind)).map((thread) => thread.id)
}

function unansweredId(detail: FeedbackDetail, viewer: string): string | null {
  if (summarizeNotes(detail.threads.map(asThread), detail.notes.map(asNote), viewer).author === 0) return null
  const sorted = detail.notes.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return sorted.at(-1)?.id ?? null
}

function ThreadList({
  prKey,
  detail,
  threadIds,
  prUrl,
  onReply,
  onResolve,
}: {
  prKey: string
  detail: FeedbackDetail
  threadIds: string[]
  prUrl: string
  onReply: (threadId: string, body: string) => Promise<void>
  onResolve: (threadId: string, resolved: boolean) => Promise<void>
}) {
  const threads = threadIds.flatMap((id) => {
    const thread = detail.threads.find((item) => item.id === id)
    return thread ? [thread] : []
  })
  if (threads.length === 0) return <p className="faint">No review threads in this list.</p>
  return (
    <>
      {detail.threadsTruncated ? (
        <p className="faint">
          Showing the first 60 threads.{' '}
          <a href={prUrl} target="_blank" rel="noreferrer">
            Open the pull request
          </a>{' '}
          for the rest.
        </p>
      ) : null}
      {threads.map((thread) => (
        <ThreadCard key={thread.id} prKey={prKey} thread={thread} prUrl={prUrl} onReply={onReply} onResolve={onResolve} />
      ))}
    </>
  )
}

function ThreadCard({
  prKey,
  thread,
  prUrl,
  onReply,
  onResolve,
}: {
  prKey: string
  thread: FeedbackThread
  prUrl: string
  onReply: (threadId: string, body: string) => Promise<void>
  onResolve: (threadId: string, resolved: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState<'reply' | 'resolve' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const href = thread.url ?? prUrl
  const label = locationLabel(thread)
  async function resolve() {
    if (lock.current) return
    lock.current = true
    setPending('resolve')
    setError(null)
    try {
      await onResolve(thread.id, !thread.isResolved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the thread')
    } finally {
      lock.current = false
      setPending(null)
    }
  }
  return (
    <article className={open ? 'thread-card' : 'thread-card collapsed'}>
      <div
        className="thread-file"
        onClick={(event) => {
          const target = event.target
          if (target instanceof Element && target.closest('a')) return
          setOpen((value) => !value)
        }}
      >
        <button
          type="button"
          className="thread-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <a className="file-link" href={href} target="_blank" rel="noreferrer" title="Open this diff on GitHub">
          {label}
        </a>
        {thread.isOutdated ? <span className="pill">Outdated</span> : null}
        {thread.isResolved ? <span className="pill">Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}</span> : null}
        {open ? null : (
          <span className="thread-count">
            {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div hidden={!open}>
      {thread.diffHunk ? <DiffHunk hunk={thread.diffHunk} /> : null}
      {thread.commentsTruncated ? <p className="faint">Earlier replies are hidden.</p> : null}
      <div className="thread-comments">
        {thread.comments.map((comment) => (
          <CommentView key={comment.id} login={comment.author?.login ?? 'Someone'} avatarUrl={comment.author?.avatarUrl ?? null} createdAt={comment.createdAt} body={comment.body} />
        ))}
      </div>
      <ReplyForm
        hint="Markdown is supported."
        pending={pending === 'reply'}
        disabled={pending !== null}
        error={error}
        onSubmit={async (body) => {
          if (lock.current) return false
          lock.current = true
          setPending('reply')
          setError(null)
          try {
            await onReply(thread.id, body)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not post the reply')
            throw caught
          } finally {
            lock.current = false
            setPending(null)
          }
        }}
        extra={
          <>
            <button type="button" className="ghost" onClick={() => void resolve()} disabled={pending !== null}>
              {pending === 'resolve' ? (thread.isResolved ? 'Unresolving' : 'Resolving') : thread.isResolved ? 'Unresolve' : 'Resolve'}
            </button>
            <FixWithCursor prKey={prKey} thread={thread} />
          </>
        }
      />
      </div>
    </article>
  )
}

function threadFix(thread: FeedbackThread): ThreadFix {
  return {
    id: thread.id,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    url: thread.url ?? threadPermalink(thread.comments),
    outdated: thread.isOutdated,
    diffHunk: thread.diffHunk,
    truncated: thread.commentsTruncated,
    comments: thread.comments.map((comment) => ({
      author: comment.author?.login ?? null,
      body: comment.body,
    })),
  }
}

function FixWithCursor({ prKey, thread }: { prKey: string; thread: FeedbackThread }) {
  const { launch, pending, error } = useAgentLaunch()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const busy = pending !== null
  const place = locationLabel(thread)

  function run(prompt: string | null) {
    const request: AgentRequest = { kind: 'thread', thread: threadFix(thread), prompt }
    void launch({ key: prKey }, request).then((opened) => {
      if (opened) setOpen(false)
    })
  }

  return (
    <>
      <div className="fix-thread">
        <div className="split-fix">
          <button
            type="button"
            className="primary"
            disabled={busy}
            aria-busy={busy}
            aria-label={`Fix ${place} with Cursor`}
            onClick={() => {
              setOpen(false)
              run(null)
            }}
          >
            {busy && !open ? 'Starting Cursor…' : 'Fix with Cursor'}
          </button>
          <button
            ref={anchor}
            type="button"
            className="primary caret"
            aria-expanded={open}
            aria-label={`Fix ${place} with a prompt`}
            disabled={busy}
            onClick={() => setOpen((current) => !current)}
          >
            ▾
          </button>
        </div>
      </div>
      {open && anchor.current ? (
        <FixPrompt anchor={anchor.current} busy={busy} error={error} onClose={() => setOpen(false)} onStart={run} />
      ) : null}
      {error && !open ? <p className="launch-error">{error}</p> : null}
    </>
  )
}

function FixPrompt({
  anchor,
  busy,
  error,
  onClose,
  onStart,
}: {
  anchor: HTMLElement
  busy: boolean
  error: string | null
  onClose: () => void
  onStart: (prompt: string) => void
}) {
  const panel = useRef<HTMLFormElement>(null)
  const [text, setText] = useState('')
  const rect = anchor.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 24)
  const height = 280
  let left = rect.right - width
  if (left < 12) left = 12
  if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12)
  const below = rect.bottom + 6
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below
  const ready = text.trim().length > 0 && text.length <= PROMPT_LIMIT

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && (anchor.contains(target) || panel.current?.contains(target))) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <form
      ref={panel}
      className="popover thread-fix"
      style={{ top, left }}
      onMouseDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        onStart(text.trim())
      }}
    >
      <h3>Fix with a prompt</h3>
      <p>Cursor still gets this thread and the pull request. These instructions are added on top.</p>
      <textarea
        aria-label="Prompt for Cursor"
        placeholder="What should Cursor do with this thread?"
        rows={4}
        autoFocus
        value={text}
        disabled={busy}
        maxLength={PROMPT_LIMIT}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <p className="faint reply-hint">⌘↵ to start</p>
      <button type="submit" className="primary resolve-cta" disabled={!ready || busy}>
        {busy ? 'Starting Cursor…' : 'Fix with Cursor'}
      </button>
      {error ? <p className="launch-error">{error}</p> : null}
    </form>,
    document.body,
  )
}

function NoteList({
  detail,
  openNotes,
  onOpen,
  onReply,
}: {
  detail: FeedbackDetail
  openNotes: Set<string>
  onOpen: (id: string) => void
  onReply: (noteId: string, body: string) => Promise<void>
}) {
  const notes = detail.notes.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  if (notes.length === 0) return <p className="faint">No conversation comments.</p>
  return (
    <>
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} open={openNotes.has(note.id)} onOpen={() => onOpen(note.id)} onReply={onReply} />
      ))}
    </>
  )
}

function NoteCard({
  note,
  open,
  onOpen,
  onReply,
}: {
  note: FeedbackNote
  open: boolean
  onOpen: () => void
  onReply: (noteId: string, body: string) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  return (
    <article className="thread-card">
      <div className="thread-file">
        <span className="note-kind">{note.kind === 'review' ? 'Review' : 'Comment'}</span>
        {note.url ? (
          <a href={note.url} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        ) : null}
      </div>
      <CommentView login={note.author?.login ?? 'Someone'} avatarUrl={note.author?.avatarUrl ?? null} createdAt={note.createdAt} body={note.body} />
      {open ? (
        <ReplyForm
          hint={replyHint(note)}
          pending={pending}
          disabled={pending}
          error={error}
          onSubmit={async (body) => {
            if (lock.current) return false
            lock.current = true
            setPending(true)
            setError(null)
            try {
              await onReply(note.id, body)
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'Could not post the reply')
              throw caught
            } finally {
              lock.current = false
              setPending(false)
            }
          }}
        />
      ) : (
        <button type="button" className="ghost reply-toggle" onClick={onOpen}>
          Reply
        </button>
      )}
    </article>
  )
}

function replyHint(note: FeedbackNote): string {
  const mention = note.author ? `mentions @${note.author.login}` : null
  const link = note.url ? 'links to the comment' : null
  const extra = [mention, link].filter((part): part is string => Boolean(part))
  if (extra.length === 0) return 'Posts a reply that quotes this comment.'
  return `Posts a reply that quotes this comment, ${extra.join(' and ')}.`
}

function ReplyForm({
  hint,
  pending,
  disabled,
  error,
  onSubmit,
  extra,
}: {
  hint: string
  pending: boolean
  disabled: boolean
  error: string | null
  onSubmit: (body: string) => Promise<void | false>
  extra?: ReactNode
}) {
  const [text, setText] = useState('')
  const sending = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const body = text.trim()
    if (!body || disabled || sending.current) return
    sending.current = true
    try {
      const posted = await onSubmit(body)
      if (posted !== false) setText('')
    } catch {
      // The caller records the message.
    } finally {
      sending.current = false
    }
  }
  return (
    <form className="reply-form" onSubmit={(event) => void submit(event)}>
      <textarea
        value={text}
        rows={4}
        placeholder="Write a reply. Markdown is supported."
        aria-label="Reply"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <p className="faint reply-hint">{hint}</p>
      {error ? <p className="launch-error">{error}</p> : null}
      <div className="thread-actions">
        <button type="submit" className="primary" disabled={disabled || text.trim().length === 0}>
          {pending ? 'Replying' : 'Reply'}
        </button>
        {extra}
      </div>
    </form>
  )
}

function CommentView({ login, avatarUrl, createdAt, body }: { login: string; avatarUrl: string | null; createdAt: string; body: string }) {
  return (
    <div className="thread-comment">
      <div className="thread-meta">
        {avatarUrl ? <img className="avatar" src={avatarUrl} alt="" /> : <span className="avatar fallback">{login.slice(0, 1).toUpperCase()}</span>}
        <strong>{login}</strong>
        {createdAt ? <time dateTime={createdAt} title={formatExact(createdAt)}>{formatWhen(createdAt)}</time> : null}
      </div>
      {body.trim() ? <Markdown className="md" text={displayBody(body)} /> : null}
    </div>
  )
}

function DiffHunk({ hunk }: { hunk: string }) {
  const lines = (hunk.endsWith('\n') ? hunk.slice(0, -1) : hunk).split('\n')
  return (
    <pre className="hunk">
      {lines.map((line, index) => (
        <div key={index} className={hunkKind(line)}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

function hunkKind(line: string): string {
  if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

const HTML_TAG = /<\/?(?:sub|sup|div|span|br|p|img|a|b|i|em|strong|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|code|pre|blockquote|hr|kbd|mark|small|center)(?:\s[^>\n]*)?>/gi

function displayBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function locationLabel(thread: FeedbackThread): string {
  const path = thread.path ?? 'Discussion'
  if (thread.startLine && thread.line && thread.startLine !== thread.line) return `${path}:${thread.startLine}-${thread.line}`
  if (thread.line) return `${path}:${thread.line}`
  return path
}
