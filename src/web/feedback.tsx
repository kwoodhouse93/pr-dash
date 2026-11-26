import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PROMPT_LIMIT, type AgentRequest, type ThreadFix } from '../shared/agents.ts'
import {
  asNote,
  asThread,
  summarizeNotes,
  threadKinds,
  threadPermalink,
  unansweredNote,
  type FeedbackCounts,
  type FeedbackDetail,
  type FeedbackNote,
  type FeedbackPayload,
  type FeedbackThread,
  type LocalResolutions,
} from '../shared/feedback.ts'
import { pullKeyRepo } from '../shared/repos.ts'
import type { PullRequest } from '../shared/types.ts'
import { useAgentLaunch, useAgentName } from './agent-launch.tsx'
import { api } from './api.ts'
import { formatExact, formatWhen } from './format.ts'
import { Markdown } from './markdown.tsx'
import { linkHostName, noteAnchor, prHref, threadAnchor, usePrHref, usePrLinkHost } from './pr-links.tsx'
import { ClickCard, CloseButton, PopBody, PopFoot, PopHead, useMenuClose, useMenuOpen } from './menus.tsx'
import { Fold, useClosing } from './motion.tsx'
import { dismiss } from './sounds.ts'

export type FeedbackFocus = 'awaiting' | 'unread' | 'unresolved' | 'resolved' | 'all' | 'comments'

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

const HERE_HINT = 'Only on this dashboard: GitHub has no way to resolve a comment. A newer comment asks for you again.'

const FOCUS_TITLE: Record<FeedbackFocus, string> = {
  awaiting: 'Awaiting you',
  unread: 'Unread',
  unresolved: 'Unresolved',
  resolved: 'Resolved unread',
  all: 'All',
  comments: 'Comments',
}

const FOCUS_HINT: Record<FeedbackFocus, string> = {
  awaiting: 'Show threads awaiting you',
  unread: 'Show unread threads',
  unresolved: 'Show unresolved threads',
  resolved: 'Show resolved threads you have not caught up on',
  all: 'Show all feedback',
  comments: 'Show comments',
}

type FeedbackApi = {
  viewer: string | null
  onCounts: (key: string, counts: FeedbackCounts) => void
}

const FeedbackContext = createContext<FeedbackApi>({ viewer: null, onCounts: () => {} })

export function FeedbackProvider({ viewer, onCounts, children }: FeedbackApi & { children: ReactNode }) {
  return <FeedbackContext.Provider value={{ viewer, onCounts }}>{children}</FeedbackContext.Provider>
}

export function useViewer(): string | null {
  return useContext(FeedbackContext).viewer
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

const FILTERS: Record<'mine' | 'review', FeedbackFocus[]> = {
  mine: ['all', 'awaiting', 'comments', 'unresolved'],
  review: ['all', 'unread', 'comments', 'resolved', 'unresolved'],
}

const FILTER_COUNT: Record<Exclude<FeedbackFocus, 'all'>, (target: FeedbackTarget) => number> = {
  awaiting: (target) => target.awaiting,
  unread: (target) => target.unread,
  unresolved: (target) => target.unresolved,
  resolved: (target) => target.resolvedUnread,
  comments: (target) => target.comments,
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
  const parts: { count: string; text: string; hot: boolean; focus: FeedbackFocus }[] = []
  const add = (focus: FeedbackFocus, count: number, label: string, hot: boolean) => {
    if (count > 0) parts.push({ count: String(count), text: `${count} ${label}`, hot, focus })
  }
  const commentLabel = comments === 1 ? 'comment' : 'comments'
  if (mode === 'review') {
    add('unread', unread, 'unread', true)
    add('comments', comments, commentLabel, reviewComments > 0)
    add('resolved', resolvedUnread, 'resolved unread', false)
  } else {
    add('awaiting', awaiting, 'awaiting', true)
    add('comments', comments, commentLabel, true)
  }
  add('unresolved', unresolved, 'unresolved', true)
  if (parts.length === 0) {
    const count = `${threads}${truncated ? '+' : ''}`
    parts.push({ count, text: `${count} thread${threads === 1 ? '' : 's'}`, hot: false, focus: 'all' })
  }
  const pending = targets.some((target) => target.detailsPending)
  const title = `${mode === 'review'
    ? 'Unread is an open thread you joined that has a newer reply. Comments are review messages and conversation notes you have not answered, highlighted when one is a review message or a conversation you joined. Resolved unread is a thread you joined that was resolved, or replied to, after you last spoke.'
    : 'Awaiting you is an open thread whose latest human comment is not yours. A comment is a conversation comment or review message you have not answered.'} Unresolved threads block merge.${pending ? ' Reply details are still loading.' : ''}`
  return (
    <span className="feedback" title={title}>
      {parts.map((part) => (
        <button
          key={part.focus}
          type="button"
          className={part.hot ? 'feedback-hit await' : 'feedback-hit'}
          title={FOCUS_HINT[part.focus]}
          aria-label={part.text}
          onClick={() => setOpen({ focus: part.focus, targets })}
        >
          <FocusIcon focus={part.focus} />
          {part.count}
        </button>
      ))}
      {open ? <FeedbackDrawer mode={mode} focus={open.focus} targets={open.targets} onClose={() => setOpen(null)} /> : null}
    </span>
  )
}

const FOCUS_ICON: Record<FeedbackFocus, ReactNode> = {
  awaiting: (
    <>
      <path d="M6.5 4 3 7.5 6.5 11" />
      <path d="M3 7.5h6a4 4 0 0 1 4 4v1" />
    </>
  ),
  unread: (
    <>
      <path d="M9 3.5H2.5V11H5v2.5L8 11h5.5V7.5" />
      <circle cx="12.6" cy="3.6" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  comments: <path d="M2.5 3.5h11V11H8l-3 2.5V11H2.5z" />,
  unresolved: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  resolved: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.6 8.2 7.3 9.9l3.1-3.5" />
    </>
  ),
  all: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
}

function FocusIcon({ focus }: { focus: FeedbackFocus }) {
  return (
    <svg className="feedback-icon" viewBox="0 0 16 16" aria-hidden="true">
      {FOCUS_ICON[focus]}
    </svg>
  )
}

function sum(targets: FeedbackTarget[], pick: (target: FeedbackTarget) => number): number {
  return targets.reduce((total, target) => total + pick(target), 0)
}

type Loaded = {
  target: FeedbackTarget
  detail: FeedbackDetail
  local: LocalResolutions
}

function loadedFrom(target: FeedbackTarget, payload: FeedbackPayload): Loaded {
  return { target: withCounts(target, payload.counts), detail: payload.detail, local: payload.local ?? {} }
}

function withCounts(target: FeedbackTarget, counts: FeedbackCounts): FeedbackTarget {
  return {
    ...target,
    threads: counts.threadCount,
    unresolved: counts.unresolvedCount,
    awaiting: counts.awaitingYouCount,
    unread: counts.unreadCount,
    resolvedUnread: counts.resolvedUnreadCount,
    comments: counts.commentAwaitingCount,
    reviewComments: counts.reviewCommentAwaitingCount,
    truncated: counts.threadsTruncated,
  }
}

/** The threads each pull request shows under a filter, fixed until the filter changes so a thread you answer stays put. */
function shownThreads(sections: Loaded[], filter: FeedbackFocus, viewer: string | null): Record<string, string[]> {
  return Object.fromEntries(sections.map((section) => [section.target.key, threadIdsFor(section.detail, filter, viewer)]))
}

function FeedbackDrawer({
  mode,
  focus,
  targets,
  onClose,
}: {
  mode: 'mine' | 'review'
  focus: FeedbackFocus
  targets: FeedbackTarget[]
  onClose: () => void
}) {
  const { viewer, onCounts } = useContext(FeedbackContext)
  const [sections, setSections] = useState<Loaded[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState(focus)
  const [shown, setShown] = useState<Record<string, string[]>>({})
  const filterNow = useRef(filter)
  const scrimPress = useRef(false)
  const key = targets.map((target) => target.key).join('\n')
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
        const next = loaded.map(({ target, payload }) => loadedFrom(target, payload))
        for (const item of loaded) onCounts(item.target.key, item.payload.counts)
        setSections(next)
        setShown(shownThreads(next, filterNow.current, viewer))
        if (viewer) {
          const ids = next.flatMap((section) => {
            const id = unansweredId(section.detail, viewer, section.local)
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
  }, [key, viewer, onCounts, targets])

  function apply(targetKey: string, payload: FeedbackPayload) {
    onCounts(targetKey, payload.counts)
    setSections((current) =>
      current?.map((section) =>
        section.target.key === targetKey ? loadedFrom(section.target, payload) : section,
      ) ?? current,
    )
  }

  function choose(next: FeedbackFocus) {
    filterNow.current = next
    setFilter(next)
    if (sections) setShown(shownThreads(sections, next, viewer))
  }

  const live = sections?.map((section) => section.target) ?? targets
  const visible = sections?.flatMap((section) => {
    const threadIds = shown[section.target.key] ?? []
    const notes = (filter === 'all' || filter === 'comments') && section.detail.notes.length > 0
    return threadIds.length > 0 || notes ? [{ section, threadIds, notes }] : []
  })
  const single = targets.length === 1 ? targets[0] : null
  const host = usePrLinkHost()
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
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <header className="drawer-head">
          <div>
            <p className="eyebrow" id="feedback-title">Feedback</p>
            {single ? (
              <a className="drawer-pr external" href={prHref(single.url, host)} target="_blank" rel="noreferrer">
                #{single.number} {single.title}
              </a>
            ) : (
              <p className="drawer-pr">{targets.length} pull requests</p>
            )}
          </div>
          <CloseButton onClose={close} />
        </header>
        <div className="feedback-filters" role="group" aria-label="Show">
          {FILTERS[mode].map((item) => (
            <button key={item} type="button" aria-pressed={filter === item} onClick={() => choose(item)}>
              {item === 'all' ? null : <FocusIcon focus={item} />}
              {FOCUS_TITLE[item]}
              {item === 'all' ? null : <span className="filter-count">{sum(live, FILTER_COUNT[item])}</span>}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {error ? <p className="launch-error">{error}</p> : null}
          {sections === null && !error ? <p className="faint">Loading feedback…</p> : null}
          {visible && visible.length === 0 ? (
            <p className="faint">{filter === 'all' ? 'No feedback yet.' : `Nothing under ${FOCUS_TITLE[filter]}.`}</p>
          ) : null}
          {visible?.map(({ section, threadIds, notes }) => (
            <section key={section.target.key} className="feedback-section">
              {targets.length > 1 ? (
                <h3>
                  <a className="external" href={prHref(section.target.url, host)} target="_blank" rel="noreferrer">
                    #{section.target.number} {section.target.title}
                  </a>
                </h3>
              ) : null}
              {notes && threadIds.length > 0 ? <p className="eyebrow">Conversation</p> : null}
              {notes ? (
                <NoteList
                  detail={section.detail}
                  local={section.local}
                  onLocal={(itemId, resolved) =>
                    api.setLocallyResolved(section.target.key, itemId, resolved).then((payload) => apply(section.target.key, payload))
                  }
                  openNotes={openNotes}
                  onOpen={(id) => setOpenNotes((current) => new Set([...current, id]))}
                  onReply={(noteId, body) => api.replyToNote(section.target.key, noteId, body).then((payload) => apply(section.target.key, payload))}
                />
              ) : null}
              {notes && threadIds.length > 0 ? <p className="eyebrow">Review threads</p> : null}
              {threadIds.length > 0 ? (
                <ThreadList
                  prKey={section.target.key}
                  detail={section.detail}
                  threadIds={threadIds}
                  prUrl={section.target.url}
                  onReply={(threadId, body) => api.replyToThread(section.target.key, threadId, body).then((payload) => apply(section.target.key, payload))}
                  onResolve={(threadId, resolved) =>
                    api.setThreadResolved(section.target.key, threadId, resolved).then((payload) => apply(section.target.key, payload))
                  }
                />
              ) : null}
            </section>
          ))}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function threadIdsFor(detail: FeedbackDetail, focus: FeedbackFocus, viewer: string | null): string[] {
  if (focus === 'comments') return []
  if (focus === 'all' || !viewer) return detail.threads.map((thread) => thread.id)
  const kind = focus === 'resolved' ? 'resolvedUnread' : focus
  return detail.threads.filter((thread) => threadKinds(asThread(thread), viewer).includes(kind)).map((thread) => thread.id)
}

function unansweredId(detail: FeedbackDetail, viewer: string, local: LocalResolutions): string | null {
  if (summarizeNotes(detail.threads.map(asThread), detail.notes.map(asNote), viewer, local).author === 0) return null
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
  const openHref = usePrHref(prUrl)
  return (
    <>
      {detail.threadsTruncated ? (
        <p className="faint">
          Showing the first 60 threads.{' '}
          <a className="external" href={openHref} target="_blank" rel="noreferrer">
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
  const [open, setOpen] = useState(!thread.isResolved)
  const [pending, setPending] = useState<'reply' | 'resolve' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const href = usePrHref(thread.url ?? prUrl, threadAnchor(thread))
  const label = locationLabel(thread)
  const hostName = linkHostName(href)
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
        <a className="file-link external" href={href} target="_blank" rel="noreferrer" title={`Open this diff on ${hostName}`}>
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
      <Fold open={open} keep>
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
      </Fold>
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
  const name = useAgentName(pullKeyRepo(prKey))
  const menuId = `thread-fix:${prKey}:${thread.id}`
  const open = useMenuOpen(menuId)
  const close = useMenuClose()
  const busy = pending !== null
  const place = locationLabel(thread)

  function run(prompt: string | null) {
    const request: AgentRequest = { kind: 'thread', thread: threadFix(thread), prompt }
    void launch({ key: prKey }, request).then((opened) => {
      if (opened) close()
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
            aria-label={`Fix ${place} with ${name}`}
            onClick={() => {
              close()
              run(null)
            }}
          >
            {busy && !open ? `Starting ${name}…` : `Fix with ${name}`}
          </button>
          <ClickCard
            id={menuId}
            className="primary caret"
            panelClassName="thread-fix"
            align="end"
            ariaLabel={`Fix ${place} with a prompt`}
            disabled={busy && !open}
            label="▾"
          >
            <FixPrompt name={name} busy={busy} error={error} onStart={run} />
          </ClickCard>
        </div>
      </div>
      {error && !open ? <p className="launch-error">{error}</p> : null}
    </>
  )
}

function FixPrompt({
  name,
  busy,
  error,
  onStart,
}: {
  /** Whatever starts the agent: Cursor, T3 Code. */
  name: string
  busy: boolean
  error: string | null
  onStart: (prompt: string) => void
}) {
  const [text, setText] = useState('')
  const ready = text.trim().length > 0 && text.length <= PROMPT_LIMIT

  return (
    <form
      className="pop-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        onStart(text.trim())
      }}
    >
      <PopHead title="Fix with a prompt" sub={`Added to the thread ${name} already gets`} />
      <PopBody>
        <textarea
          aria-label={`Prompt for ${name}`}
          placeholder={`What should ${name} do with this thread?`}
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
        {error ? <p className="launch-error">{error}</p> : null}
      </PopBody>
      <PopFoot hint={<><kbd>⌘↵</kbd> to start</>}>
        <button type="submit" className="primary" disabled={!ready || busy}>
          {busy ? `Starting ${name}…` : `Fix with ${name}`}
        </button>
      </PopFoot>
    </form>
  )
}

function NoteList({
  detail,
  local,
  openNotes,
  onOpen,
  onReply,
  onLocal,
}: {
  detail: FeedbackDetail
  local: LocalResolutions
  openNotes: Set<string>
  onOpen: (id: string) => void
  onReply: (noteId: string, body: string) => Promise<void>
  onLocal: (noteId: string, resolved: boolean) => Promise<void>
}) {
  const viewer = useViewer()
  const notes = detail.notes.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  // Only the newest note can be owed a reply, so it is the only one there is anything to resolve on.
  const owed = viewer ? (unansweredNote(detail.threads.map(asThread), detail.notes.map(asNote), viewer)?.id ?? null) : null
  return (
    <>
      {notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          here={note.id === owed && Object.hasOwn(local, note.id)}
          owed={note.id === owed}
          open={openNotes.has(note.id)}
          onOpen={() => onOpen(note.id)}
          onReply={onReply}
          onLocal={onLocal}
        />
      ))}
    </>
  )
}

function NoteCard({
  note,
  here,
  owed,
  open,
  onOpen,
  onReply,
  onLocal,
}: {
  note: FeedbackNote
  /** Resolved on this dashboard only. */
  here: boolean
  /** The note the viewer has not answered. */
  owed: boolean
  open: boolean
  onOpen: () => void
  onReply: (noteId: string, body: string) => Promise<void>
  onLocal: (noteId: string, resolved: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const href = usePrHref(note.url ?? '', noteAnchor(note))
  const hostName = linkHostName(href)
  async function resolveHere() {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      await onLocal(note.id, !here)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the comment')
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  const hereButton = owed ? (
    <button type="button" className="ghost reply-toggle" title={HERE_HINT} onClick={() => void resolveHere()} disabled={pending}>
      {here ? 'Unresolve' : 'Resolve'}
    </button>
  ) : null
  return (
    <article className="thread-card">
      <div className="thread-file">
        <span className="note-kind">{note.kind === 'review' ? 'Review' : 'Comment'}</span>
        {here ? <span className="pill" title={HERE_HINT}>Resolved</span> : null}
        {note.url ? (
          <a className="external" href={href} target="_blank" rel="noreferrer">
            View on {hostName}
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
          extra={hereButton}
        />
      ) : (
        <div className="note-actions">
          <button type="button" className="ghost reply-toggle" onClick={onOpen}>
            Reply
          </button>
          {hereButton}
          {error ? <p className="launch-error">{error}</p> : null}
        </div>
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
