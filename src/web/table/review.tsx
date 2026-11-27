import { approvedByLogin } from '../../shared/approval.ts'
import type { StackSummary } from '../../shared/stacks.ts'
import type { MergeMark, PullRequest } from '../../shared/types.ts'
import { useViewer } from '../feedback.tsx'
import { HoverCard, PopBody, PopHead } from '../menus.tsx'
import { useStackLock } from './context.tsx'
import { Icon } from '../icons.tsx'

function mergeTitle(mark: MergeMark, changes: boolean): string {
  if (changes) return 'Changes requested'
  if (mark === 'met') return 'Enough to merge'
  if (mark === 'unmet') return 'Review still required'
  if (mark === 'draft') return 'Draft, no review requirement'
  return 'No review requirement'
}

function reviewClass(done: boolean, waiting: boolean) {
  if (done) return 'mark met'
  if (waiting) return 'mark on'
  return 'mark'
}

function humanReviewClass(changes: boolean, mine: boolean, human: boolean, waiting: boolean) {
  if (changes) return 'mark changes'
  if (mine) return 'mark mine'
  if (human) return 'mark met'
  if (waiting) return 'mark on'
  return 'mark'
}

function humanReviewTitle(changes: boolean, mine: boolean, human: boolean, waiting: boolean) {
  if (changes) return 'Changes requested'
  if (mine) return 'Approved by you'
  if (human) return 'Approved by a person'
  if (waiting) return 'Awaiting a person'
  return 'No review requested'
}

function approvedBy(prs: PullRequest[], login: string | null): boolean {
  return prs.every((pr) => approvedByLogin(pr, login))
}

export function ReviewControl({ id, prs, summary }: { id: string; prs: PullRequest[]; summary?: StackSummary }) {
  const viewer = useViewer()
  const any = summary?.anyApproval ?? prs[0]!.anyApproval
  const human = summary?.humanApproval ?? prs[0]!.humanApproval
  const mine = approvedBy(prs, viewer)
  const changes = summary?.changesRequested ?? prs[0]!.changesRequested
  const mark = summary?.mergeMark ?? prs[0]!.mergeMark
  const needed = mark === 'met' || mark === 'unmet'
  const { locked } = useStackLock()
  return (
    <HoverCard
      id={id}
      disabled={locked}
      className="marks"
      label={
        <>
          <span className="sr">Review</span>
          <i className={reviewClass(any, needed)} title={any ? 'Approved' : needed ? 'Awaiting approval' : 'No review requested'}>
            <Icon name="approved" />
          </i>
          <i className={humanReviewClass(changes, mine, human, needed)} title={humanReviewTitle(changes, mine, human, needed)}>
            <Icon name="person" />
          </i>
          <i className={reviewClass(mark === 'met', mark === 'unmet')} title={mergeTitle(mark, changes)}>
            <Icon name="mergeable" />
          </i>
        </>
      }
    >
      <PopHead title="Reviews" />
      <PopBody>
        {prs.map((pr) => (
          <div key={pr.id} className="review-line">
            {prs.length > 1 ? <span className="review-num">#{pr.number}</span> : null}
            {pr.reviewers.length === 0 ? <span className="review-none">No reviews yet</span> : null}
            {pr.reviewers.map((reviewer) => (
              <span
                key={reviewer.login}
                className={`reviewer ${reviewer.state === 'APPROVED' ? 'approved' : 'changes'}`}
                title={`${reviewer.login}${reviewer.human ? '' : ' (bot)'}: ${reviewer.state === 'APPROVED' ? 'approved' : 'changes requested'}`}
              >
                {reviewer.avatarUrl ? (
                  <img src={reviewer.avatarUrl} alt="" />
                ) : (
                  <span className="avatar fallback" aria-hidden="true">
                    {reviewer.login.slice(0, 1).toUpperCase()}
                  </span>
                )}
                {reviewer.login}
                <span className="sr">{reviewer.state === 'APPROVED' ? ' approved' : ' requested changes'}</span>
              </span>
            ))}
          </div>
        ))}
      </PopBody>
    </HoverCard>
  )
}
