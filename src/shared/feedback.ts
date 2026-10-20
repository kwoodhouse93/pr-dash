type Comment = {
  author: { __typename: string; login: string } | null
  createdAt: string
}

export type Thread = {
  isResolved: boolean
  comments: Comment[]
}

export function summarizeThreads(threads: Thread[], viewerLogin: string): {
  threadCount: number
  unresolvedCount: number
  awaitingYouCount: number
} {
  let unresolvedCount = 0
  let awaitingYouCount = 0
  for (const thread of threads) {
    if (thread.isResolved) continue
    unresolvedCount += 1
    const humans = thread.comments
      .filter((comment) => comment.author?.__typename === 'User' && comment.author.login)
      .slice()
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    const latest = humans.at(-1)
    if (latest && latest.author!.login !== viewerLogin) awaitingYouCount += 1
  }
  return { threadCount: threads.length, unresolvedCount, awaitingYouCount }
}
