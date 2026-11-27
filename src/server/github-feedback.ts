import { asNote, asThread, type FeedbackAuthor, feedbackCounts, type FeedbackDetail, type FeedbackNote, type FeedbackPayload, type LocalResolutions, quoteReply, threadPermalink } from '../shared/feedback.ts'
import { COMMENT_GONE, Refused } from './errors.ts'
import { graphql } from './github-client.ts'

const FEEDBACK_QUERY = `
  query Feedback($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id title url number
        reviewThreads(first: 60) {
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            startLine
            originalStartLine
            resolvedBy { login }
            comments(last: 30) {
              pageInfo { hasPreviousPage }
              nodes {
                id
                body
                createdAt
                url
                diffHunk
                author { __typename login avatarUrl }
              }
            }
          }
        }
        comments(last: 20) {
          nodes { id body createdAt url author { __typename login avatarUrl } }
        }
        reviews(last: 40) {
          nodes { id state submittedAt body url author { __typename login avatarUrl } }
        }
      }
    }
  }
`

const REPLY_THREAD = `
  mutation ReplyThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id }
    }
  }
`

const RESOLVE_THREAD = `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const UNRESOLVE_THREAD = `
  mutation UnresolveThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const ADD_COMMENT = `
  mutation AddComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
  }
`

type RawActor = { __typename: string; login: string; avatarUrl?: string | null } | null

type RawFeedbackComment = {
  id: string
  body: string
  createdAt: string
  url: string | null
  diffHunk?: string | null
  author: RawActor
}

type RawFeedback = {
  repository: {
    pullRequest: {
      id: string
      title: string
      url: string
      number: number
      reviewThreads: {
        pageInfo: { hasNextPage: boolean }
        nodes: Array<{
          id: string
          isResolved: boolean
          isOutdated: boolean
          path: string | null
          line: number | null
          originalLine: number | null
          startLine: number | null
          originalStartLine: number | null
          resolvedBy: { login: string } | null
          comments: {
            pageInfo: { hasPreviousPage: boolean }
            nodes: Array<RawFeedbackComment | null> | null
          }
        } | null> | null
      }
      comments: { nodes: Array<{ id: string; body: string; createdAt: string; url: string | null; author: RawActor } | null> | null }
      reviews: {
        nodes: Array<{
          id: string
          state: string
          submittedAt: string | null
          body: string | null
          url: string | null
          author: RawActor
        } | null> | null
      }
    } | null
  } | null
}

const SKIPPED_REVIEW = new Set(['PENDING', 'DISMISSED'])

function feedbackAuthor(author: RawActor): FeedbackAuthor | null {
  if (!author?.login) return null
  return { __typename: author.__typename, login: author.login, avatarUrl: author.avatarUrl ?? null }
}

function mapFeedback(data: RawFeedback): FeedbackDetail {
  const pull = data.repository?.pullRequest
  if (!pull) throw new Error('That pull request was not found.')
  const threads = (pull.reviewThreads.nodes ?? []).filter((thread): thread is NonNullable<typeof thread> => thread != null).map((thread) => {
    const comments = (thread.comments.nodes ?? []).filter((comment): comment is RawFeedbackComment => comment != null).map((comment) => ({
      id: comment.id,
      author: feedbackAuthor(comment.author),
      createdAt: comment.createdAt,
      body: comment.body ?? '',
      url: comment.url,
      diffHunk: comment.diffHunk ?? null,
    }))
    const hunk = comments.find((comment) => comment.diffHunk)?.diffHunk ?? null
    return {
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      resolvedBy: thread.resolvedBy?.login ?? null,
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      startLine: thread.startLine ?? thread.originalStartLine,
      url: threadPermalink(comments),
      diffHunk: hunk,
      commentsTruncated: thread.comments.pageInfo.hasPreviousPage,
      comments,
    }
  })
  const commentNotes: FeedbackNote[] = (pull.comments.nodes ?? []).flatMap((comment) => {
    if (!comment) return []
    const author = feedbackAuthor(comment.author)
    if (author?.__typename !== 'User' || !comment.body.trim()) return []
    return [{ id: comment.id, author, createdAt: comment.createdAt, body: comment.body, url: comment.url, kind: 'comment' as const }]
  })
  const reviewNotes: FeedbackNote[] = (pull.reviews.nodes ?? []).flatMap((review) => {
    if (!review || SKIPPED_REVIEW.has(review.state) || !review.body?.trim()) return []
    const author = feedbackAuthor(review.author)
    if (author?.__typename !== 'User') return []
    return [{
      id: review.id,
      author,
      createdAt: review.submittedAt ?? '',
      body: review.body ?? '',
      url: review.url,
      kind: 'review' as const,
    }]
  })
  return {
    pullId: pull.id,
    title: pull.title,
    url: pull.url,
    number: pull.number,
    threadsTruncated: pull.reviewThreads.pageInfo.hasNextPage,
    threads,
    notes: [...commentNotes, ...reviewNotes],
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Unknown repository ${repo}.`)
  return { owner, name }
}

export async function fetchPullFeedback(token: string, repo: string, number: number): Promise<FeedbackDetail> {
  const { owner, name } = splitRepo(repo)
  const data = await graphql<RawFeedback>(token, FEEDBACK_QUERY, { owner, name, number })
  return mapFeedback(data)
}

function requireReply(body: string): string {
  const text = body.trim()
  if (!text) {
    throw new Refused('Write a reply first.')
  }
  return text
}

export async function replyToReviewThread(token: string, repo: string, number: number, threadId: string, body: string): Promise<FeedbackDetail> {
  const text = requireReply(body)
  await graphql(token, REPLY_THREAD, { threadId, body: text })
  return fetchPullFeedback(token, repo, number)
}

export async function setReviewThreadResolved(
  token: string,
  repo: string,
  number: number,
  threadId: string,
  resolved: boolean,
): Promise<FeedbackDetail> {
  await graphql(token, resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId })
  return fetchPullFeedback(token, repo, number)
}

export async function replyToPullNote(token: string, repo: string, number: number, noteId: string, body: string): Promise<FeedbackDetail> {
  const text = requireReply(body)
  const current = await fetchPullFeedback(token, repo, number)
  const note = current.notes.find((item) => item.id === noteId)
  if (!note) {
    throw new Refused(COMMENT_GONE, 404)
  }
  const quoted = quoteReply({ authorLogin: note.author?.login ?? null, body: note.body, url: note.url }, text)
  await graphql(token, ADD_COMMENT, { subjectId: current.pullId, body: quoted })
  return fetchPullFeedback(token, repo, number)
}

export function payloadFor(detail: FeedbackDetail, viewerLogin: string, local: LocalResolutions = {}): FeedbackPayload {
  const ids = detail.notes.map((note) => note.id)
  return {
    detail,
    counts: feedbackCounts(detail.threads.map(asThread), detail.notes.map(asNote), viewerLogin, detail.threadsTruncated, local),
    local: Object.fromEntries(ids.flatMap((id) => (Object.hasOwn(local, id) ? [[id, local[id]!]] : []))),
  }
}
