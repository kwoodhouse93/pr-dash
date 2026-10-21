type Comment = {
  author: { __typename: string; login: string } | null
  createdAt: string
}

export type Thread = {
  isResolved: boolean
  resolvedBy?: string | null
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
  for (const thread of threads) {
    const humans = humanComments(thread.comments)
    const latest = humans.at(-1)
    const involved = humans.some((comment) => comment.author!.login === viewerLogin)
    const replied = Boolean(latest && latest.author!.login !== viewerLogin)
    const resolvedByOther = Boolean(thread.resolvedBy && thread.resolvedBy !== viewerLogin)
    if (!thread.isResolved) {
      unresolvedCount += 1
      if (replied) awaitingYouCount += 1
      if (involved && replied) unreadCount += 1
      continue
    }
    if (involved && (replied || resolvedByOther)) resolvedUnreadCount += 1
  }
  return {
    threadCount: threads.length,
    unresolvedCount,
    awaitingYouCount,
    unreadCount,
    resolvedUnreadCount,
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
