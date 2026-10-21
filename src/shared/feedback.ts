import type { PullRequest } from './types.ts'

type Comment = {
  author: { __typename: string; login: string } | null
  createdAt: string
}

export type Thread = {
  isResolved: boolean
  resolvedBy?: string | null
  url?: string | null
  comments: Comment[]
}

export type Note = {
  author: { __typename: string; login: string } | null
  createdAt: string
  body: string
  kind: 'comment' | 'review'
}

export type FeedbackSummary = {
  threadCount: number
  unresolvedCount: number
  awaitingYouCount: number
  unreadCount: number
  resolvedUnreadCount: number
  awaitingUrl: string | null
  unresolvedUrl: string | null
  unreadUrl: string | null
  resolvedUnreadUrl: string | null
}

/** Prefer the newest comment permalink so the link lands on the latest reply. */
export function threadPermalink(comments: { url?: string | null }[]): string | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const url = comments[index]?.url
    if (url) return url
  }
  return null
}

function keepFirst(current: string | null, url: string | null | undefined): string | null {
  return current ?? url ?? null
}

function humanComments(comments: Comment[]): Comment[] {
  return comments
    .filter((comment) => comment.author?.__typename === 'User' && comment.author.login)
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export type ThreadKind = 'awaiting' | 'unread' | 'unresolved' | 'resolvedUnread'

/** Buckets a thread the same way the feedback column counts it. */
export function threadKinds(thread: Thread, viewerLogin: string): ThreadKind[] {
  const humans = humanComments(thread.comments)
  const latest = humans.at(-1)
  const involved = humans.some((comment) => comment.author!.login === viewerLogin)
  const replied = Boolean(latest && latest.author!.login !== viewerLogin)
  const resolvedByOther = Boolean(thread.resolvedBy && thread.resolvedBy !== viewerLogin)
  if (!thread.isResolved) {
    const kinds: ThreadKind[] = ['unresolved']
    if (replied) kinds.push('awaiting')
    if (involved && replied) kinds.push('unread')
    return kinds
  }
  if (involved && (replied || resolvedByOther)) return ['resolvedUnread']
  return []
}

export function summarizeThreads(threads: Thread[], viewerLogin: string): FeedbackSummary {
  const counts: Record<ThreadKind, number> = { awaiting: 0, unread: 0, unresolved: 0, resolvedUnread: 0 }
  const urls: Record<ThreadKind, string | null> = { awaiting: null, unread: null, unresolved: null, resolvedUnread: null }
  for (const thread of threads) {
    for (const kind of threadKinds(thread, viewerLogin)) {
      counts[kind] += 1
      urls[kind] = keepFirst(urls[kind], thread.url)
    }
  }
  return {
    threadCount: threads.length,
    unresolvedCount: counts.unresolved,
    awaitingYouCount: counts.awaiting,
    unreadCount: counts.unread,
    resolvedUnreadCount: counts.resolvedUnread,
    awaitingUrl: urls.awaiting,
    unresolvedUrl: urls.unresolved,
    unreadUrl: urls.unread,
    resolvedUnreadUrl: urls.resolvedUnread,
  }
}

/** Keep reply counts when a list refresh did not load thread comments and the pull request is unchanged. */
export function carryThreadFeedback(previous: PullRequest | undefined, next: PullRequest): PullRequest {
  if (!previous?.feedbackAt || previous.feedbackAt !== next.updatedAt) return next
  return {
    ...next,
    awaitingYouCount: previous.awaitingYouCount,
    unreadCount: previous.unreadCount,
    resolvedUnreadCount: previous.resolvedUnreadCount,
    awaitingThreadUrl: previous.awaitingThreadUrl,
    unresolvedThreadUrl: previous.unresolvedThreadUrl,
    unreadThreadUrl: previous.unreadThreadUrl,
    resolvedUnreadThreadUrl: previous.resolvedUnreadThreadUrl,
    commentAwaitingCount: previous.commentAwaitingCount,
    reviewCommentAwaitingCount: previous.reviewCommentAwaitingCount,
    feedbackAt: previous.feedbackAt,
  }
}

function humanNotes(notes: Note[]): Note[] {
  return notes
    .filter((note) => note.author?.__typename === 'User' && note.author.login && note.body.trim() && !Number.isNaN(Date.parse(note.createdAt)))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** The conversation note the viewer still owes a reply, if there is one. */
export function unansweredNote(threads: Thread[], notes: Note[], viewerLogin: string): Note | null {
  let viewerThreadAt = Number.NEGATIVE_INFINITY
  let viewerSpoke = false
  for (const thread of threads) {
    for (const comment of humanComments(thread.comments)) {
      if (comment.author!.login !== viewerLogin) continue
      const at = Date.parse(comment.createdAt)
      if (Number.isNaN(at)) continue
      viewerSpoke = true
      if (at > viewerThreadAt) viewerThreadAt = at
    }
  }
  const humans = humanNotes(notes)
  const latest = humans.at(-1)
  if (!latest || latest.author!.login === viewerLogin) return null
  if (viewerSpoke && viewerThreadAt > Date.parse(latest.createdAt)) return null
  return latest
}

export function summarizeNotes(threads: Thread[], notes: Note[], viewerLogin: string): { author: number; reviewer: number } {
  const latest = unansweredNote(threads, notes, viewerLogin)
  if (!latest) return { author: 0, reviewer: 0 }
  const involved = humanNotes(notes).some((note) => note.author!.login === viewerLogin)
  return { author: 1, reviewer: involved || latest.kind === 'review' ? 1 : 0 }
}

export type FeedbackAuthor = {
  __typename: string
  login: string
  avatarUrl: string | null
}

export type FeedbackComment = {
  id: string
  author: FeedbackAuthor | null
  createdAt: string
  body: string
  url: string | null
  diffHunk: string | null
}

export type FeedbackThread = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  path: string | null
  line: number | null
  startLine: number | null
  url: string | null
  diffHunk: string | null
  commentsTruncated: boolean
  comments: FeedbackComment[]
}

export type FeedbackNote = {
  id: string
  author: FeedbackAuthor | null
  createdAt: string
  body: string
  url: string | null
  kind: 'comment' | 'review'
}

export type FeedbackDetail = {
  pullId: string
  title: string
  url: string
  number: number
  threadsTruncated: boolean
  threads: FeedbackThread[]
  notes: FeedbackNote[]
}

export type FeedbackCounts = {
  threadCount: number
  unresolvedCount: number
  awaitingYouCount: number
  unreadCount: number
  resolvedUnreadCount: number
  awaitingThreadUrl: string | null
  unresolvedThreadUrl: string | null
  unreadThreadUrl: string | null
  resolvedUnreadThreadUrl: string | null
  commentAwaitingCount: number
  reviewCommentAwaitingCount: number
  threadsTruncated: boolean
}

export type FeedbackPayload = {
  detail: FeedbackDetail
  counts: FeedbackCounts
}

export function asThread(thread: FeedbackThread): Thread {
  return {
    isResolved: thread.isResolved,
    resolvedBy: thread.resolvedBy,
    url: thread.url ?? threadPermalink(thread.comments),
    comments: thread.comments.map((comment) => ({ author: comment.author, createdAt: comment.createdAt })),
  }
}

export function asNote(note: FeedbackNote): Note {
  return { author: note.author, createdAt: note.createdAt, body: note.body, kind: note.kind }
}

export function feedbackCounts(threads: Thread[], notes: Note[], viewerLogin: string, threadsTruncated: boolean): FeedbackCounts {
  const summary = summarizeThreads(threads, viewerLogin)
  const comments = summarizeNotes(threads, notes, viewerLogin)
  return {
    threadCount: summary.threadCount,
    unresolvedCount: summary.unresolvedCount,
    awaitingYouCount: summary.awaitingYouCount,
    unreadCount: summary.unreadCount,
    resolvedUnreadCount: summary.resolvedUnreadCount,
    awaitingThreadUrl: summary.awaitingUrl,
    unresolvedThreadUrl: summary.unresolvedUrl,
    unreadThreadUrl: summary.unreadUrl,
    resolvedUnreadThreadUrl: summary.resolvedUnreadUrl,
    commentAwaitingCount: comments.author,
    reviewCommentAwaitingCount: comments.reviewer,
    threadsTruncated,
  }
}

/**
 * Conversation replies are flat issue comments, so the reply quotes the
 * comment, mentions its author, and links to that comment.
 */
export function quoteReply(note: { authorLogin: string | null; body: string; url: string | null }, reply: string): string {
  const text = reply.trim()
  if (!text) {
    const error = new Error('Write a reply first.')
    error.name = 'FeedbackRejected'
    throw error
  }
  const quoted = note.body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  const mention = note.authorLogin ? `@${note.authorLogin}` : ''
  const head = [mention, note.url ?? ''].filter((part) => part.length > 0).join('\n')
  return [head, quoted, text].filter((part) => part.length > 0).join('\n\n')
}
