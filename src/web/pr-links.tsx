import { createContext, useContext, type ReactNode } from 'react'
import { graphitePrUrl } from './format.ts'

/** Where number, title, queue, and feedback links open. The Open column stays both hosts. */
export type PrLinkHost = 'github' | 'graphite'

/**
 * Graphite's own permalink, taken from the app client.
 * Review threads and inline comments use the changes tab; conversation comments
 * and review summaries use the activity tab. The id is GitHub's GraphQL node id
 * (`PRRT_…`, `PRRC_…`, `IC_…`, `PRR_…`), not the numeric id in a GitHub hash.
 */
export type GraphiteAnchor =
  | { kind: 'thread' | 'comment' | 'discussion' | 'review'; id: string }

const GITHUB_PULL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/
const GITHUB_COMMENT_HASH = /^(?:discussion_r\d+|issuecomment-\d+|pullrequestreview-\d+|r\d+)$/

const PrLinksContext = createContext<PrLinkHost>('github')

export function PrLinksProvider({ host, children }: { host: PrLinkHost; children: ReactNode }) {
  return <PrLinksContext.Provider value={host}>{children}</PrLinksContext.Provider>
}

export function usePrLinkHost(): PrLinkHost {
  return useContext(PrLinksContext)
}

export function usePrHref(githubUrl: string, anchor?: GraphiteAnchor | null): string {
  return prHref(githubUrl, usePrLinkHost(), anchor)
}

export function prHref(githubUrl: string, host: PrLinkHost, anchor?: GraphiteAnchor | null): string {
  if (host !== 'graphite') return githubUrl
  const pull = parseGithubPull(githubUrl)
  if (!pull) return githubUrl
  const base = graphitePrUrl(`${pull.owner}/${pull.repo}`, Number(pull.number))
  const hash = anchorHash(anchor)
  if (hash) {
    const tab = anchor?.kind === 'thread' || anchor?.kind === 'comment' ? 'changes' : 'activity'
    return `${base}/${tab}#${hash}`
  }
  if (pull.hash && GITHUB_COMMENT_HASH.test(pull.hash)) return githubUrl
  if (pull.hash) return githubUrl
  return base
}

/** Latest inline reply, so the Graphite link lands where the GitHub comment hash would. */
export function threadAnchor(thread: { id: string; comments: { id: string }[] }): GraphiteAnchor | null {
  for (let index = thread.comments.length - 1; index >= 0; index -= 1) {
    const id = thread.comments[index]?.id
    if (id) return { kind: 'comment', id }
  }
  return thread.id ? { kind: 'thread', id: thread.id } : null
}

export function noteAnchor(note: { id: string; kind: 'comment' | 'review' }): GraphiteAnchor | null {
  if (!note.id) return null
  return note.kind === 'review' ? { kind: 'review', id: note.id } : { kind: 'discussion', id: note.id }
}

export function linkHostName(href: string): 'GitHub' | 'Graphite' {
  return href.startsWith('https://app.graphite.com/') ? 'Graphite' : 'GitHub'
}

function parseGithubPull(url: string): { owner: string; repo: string; number: string; hash: string } | null {
  const match = GITHUB_PULL.exec(url)
  if (!match) return null
  const hash = new URL(url).hash.replace(/^#/, '')
  return { owner: match[1]!, repo: match[2]!, number: match[3]!, hash }
}

function anchorHash(anchor: GraphiteAnchor | null | undefined): string | null {
  const id = anchor?.id
  if (!anchor || !id) return null
  const prefix = anchor.kind === 'thread' ? 'thread' : anchor.kind === 'comment' ? 'comment' : anchor.kind === 'discussion' ? 'discussion' : 'review'
  return `${prefix}-${encodeURIComponent(id)}`
}
