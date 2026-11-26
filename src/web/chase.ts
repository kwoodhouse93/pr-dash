import type { PullRequest } from '../shared/types.ts'
import { graphitePrUrl } from './format.ts'

type ChasePr = Pick<
  PullRequest,
  'repo' | 'repoName' | 'number' | 'title' | 'url' | 'isDraft' | 'additions' | 'deletions' | 'reviewDecision' | 'humanApproval' | 'createdAt' | 'readyAt'
>

export type ChaseMessage = { text: string; html: string }

/** GitHub's verdict where the branch has review rules, otherwise any approval from a person. */
function approved(pr: ChasePr): boolean {
  return pr.reviewDecision ? pr.reviewDecision === 'APPROVED' : pr.humanApproval
}

function waiting(pr: ChasePr, now: number): string {
  const since = Date.parse(pr.readyAt ?? pr.createdAt)
  const minutes = Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / 60_000))
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute')
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), 'hour')
  return unit(Math.floor(minutes / (24 * 60)), 'day')
}

/**
 * Slack pastes the plain text, and ignores the HTML, whenever the plain text looks like Markdown: a line starting `1. `, backticks, or `*emphasis*`.
 * So the plain version numbers its lines `1)` and swaps those characters in titles for ones that look alike.
 */
function plainTitle(title: string): string {
  return title.replace(/`/g, "'").replace(/\*/g, '∗').replace(/~~/g, '~ ~')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A message asking for review of the given pull requests, bottom of the stack first, as plain text and as HTML so the links survive a paste into Slack.
 * Drafts are left out. Null when nothing is left to review.
 */
export function reviewChase(prs: ChasePr[], now = Date.now()): ChaseMessage | null {
  const open = prs.filter((pr) => !pr.isDraft)
  const needing = open.filter((pr) => !approved(pr))
  if (!needing.length) return null

  const manyRepos = new Set(open.map((pr) => pr.repo)).size > 1
  const id = (pr: ChasePr) => (manyRepos ? `${pr.repoName}#${pr.number}` : `#${pr.number}`)
  const size = (pr: ChasePr) => `+${pr.additions} −${pr.deletions}`
  const line = (pr: ChasePr, extra: string[]) => {
    const facts = [size(pr), ...extra]
    const graphite = graphitePrUrl(pr.repo, pr.number)
    return {
      text: [`${id(pr)} ${plainTitle(pr.title)}`, ...facts, `GitHub: ${pr.url}`, `Graphite: ${graphite}`].join(' · '),
      html: [
        `<code>${escapeHtml(id(pr))}</code> ${escapeHtml(pr.title)}`,
        ...facts.map(escapeHtml),
        `<a href="${escapeHtml(pr.url)}">GitHub</a>`,
        `<a href="${escapeHtml(graphite)}">Graphite</a>`,
      ].join(' · '),
    }
  }
  const opener = '👀 Still looking for review'

  if (open.length === 1) {
    const only = line(open[0]!, [`waiting ${waiting(open[0]!, now)}`])
    return { text: `${opener} - ${only.text}`, html: `<p>${opener} - ${only.html}</p>` }
  }

  const oldest = needing.reduce((a, b) => (Date.parse(b.readyAt ?? b.createdAt) < Date.parse(a.readyAt ?? a.createdAt) ? b : a))
  const head =
    needing.length === 1
      ? `${opener} - 1 needs review, waiting ${waiting(oldest, now)}`
      : `${opener} - ${needing.length} need review, oldest has been waiting ${waiting(oldest, now)}`
  const lines = open.map((pr) => line(pr, approved(pr) ? ['✅ approved'] : []))
  return {
    text: [head, '', ...lines.map((item, index) => `${index + 1}) ${item.text}`)].join('\n'),
    html: `<p>${head}</p><ol>${lines.map((item) => `<li>${item.html}</li>`).join('')}</ol>`,
  }
}
