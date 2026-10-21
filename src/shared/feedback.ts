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

export function summarizeThreads(threads: Thread[], viewerLogin: string): FeedbackSummary {
  let unresolvedCount = 0
  let awaitingYouCount = 0
  let unreadCount = 0
  let resolvedUnreadCount = 0
  let awaitingUrl: string | null = null
  let unresolvedUrl: string | null = null
  let unreadUrl: string | null = null
  let resolvedUnreadUrl: string | null = null
  for (const thread of threads) {
    const humans = humanComments(thread.comments)
    const latest = humans.at(-1)
    const involved = humans.some((comment) => comment.author!.login === viewerLogin)
    const replied = Boolean(latest && latest.author!.login !== viewerLogin)
    const resolvedByOther = Boolean(thread.resolvedBy && thread.resolvedBy !== viewerLogin)
    if (!thread.isResolved) {
      unresolvedCount += 1
      unresolvedUrl = keepFirst(unresolvedUrl, thread.url)
      if (replied) {
        awaitingYouCount += 1
        awaitingUrl = keepFirst(awaitingUrl, thread.url)
      }
      if (involved && replied) {
        unreadCount += 1
        unreadUrl = keepFirst(unreadUrl, thread.url)
      }
      continue
    }
    if (involved && (replied || resolvedByOther)) {
      resolvedUnreadCount += 1
      resolvedUnreadUrl = keepFirst(resolvedUnreadUrl, thread.url)
    }
  }
  return {
    threadCount: threads.length,
    unresolvedCount,
    awaitingYouCount,
    unreadCount,
    resolvedUnreadCount,
    awaitingUrl,
    unresolvedUrl,
    unreadUrl,
    resolvedUnreadUrl,
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

export function summarizeNotes(threads: Thread[], notes: Note[], viewerLogin: string): { author: number; reviewer: number } {
  const none = { author: 0, reviewer: 0 }
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
  const humans = notes
    .filter((note) => note.author?.__typename === 'User' && note.author.login && note.body.trim() && !Number.isNaN(Date.parse(note.createdAt)))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const latest = humans.at(-1)
  if (!latest || latest.author!.login === viewerLogin) return none
  if (viewerSpoke && viewerThreadAt > Date.parse(latest.createdAt)) return none
  const involved = humans.some((note) => note.author!.login === viewerLogin)
  return { author: 1, reviewer: involved || latest.kind === 'review' ? 1 : 0 }
}
