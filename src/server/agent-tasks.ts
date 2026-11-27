import { failingChecks, threadPlace, type AgentRequest, type ThreadFix } from '../shared/agents.ts'
import type { PullRequest } from '../shared/types.ts'

export type AgentTask = { name: string; prompt: string }

/** `upstack` is every pull request stacked above this one, each after the one it is based on. Only a conflict uses it. */
export function agentTask(pr: PullRequest, request: AgentRequest, upstack: PullRequest[] = []): AgentTask {
  switch (request.kind) {
    case 'conflict':
      return {
        name: `Resolve #${pr.number} merge conflict`,
        prompt: [
          `Resolve the merge conflict on pull request #${pr.number}.`,
          'Bring in its base branch, preserve the intended changes from both sides, run relevant checks, and push the resolution.',
          ...restack(pr, upstack),
          '',
          ...context(pr, upstack),
        ].join('\n'),
      }
    case 'ci':
      return {
        name: `Investigate #${pr.number} CI failure`,
        prompt: [
          `Investigate the failing CI checks on pull request #${pr.number}.`,
          '',
          'Failing checks on the latest commit:',
          ...failingChecks(pr).map((check) => {
            const detail = [check.workflowName ? `workflow ${check.workflowName}` : null, check.required ? 'required' : 'optional']
              .filter(Boolean)
              .join(', ')
            const run = check.workflowRunId ? `, run ${check.workflowRunId}` : ''
            return `- ${check.name} (${detail}${run})${check.url ? `: ${check.url}` : ''}`
          }),
          '',
          `Read the logs for each failure. For a GitHub Actions run, \`gh run view <run> --repo ${pr.repo} --log-failed\` prints the failed steps.`,
          'Work out what failed and why.',
          'If the cause is clear and the fix belongs in this pull request, make the fix, run the relevant checks, and push it.',
          'If the failure looks flaky, comes from infrastructure or code outside this pull request, or the fix is not obvious, do not push. Report what you found instead.',
          'End with a short summary: what failed, why, and whether you pushed a fix.',
          '',
          ...context(pr),
        ].join('\n'),
      }
    case 'prompt':
      return {
        name: `#${pr.number}: ${headline(request.prompt)}`,
        prompt: [request.prompt.trim(), '', ...context(pr)].join('\n'),
      }
    case 'thread': {
      const extra = request.prompt?.trim() ?? ''
      const place = threadPlace(request.thread)
      return {
        name: named(extra ? `#${pr.number}: ${headline(extra)}` : `Fix #${pr.number} ${place}`),
        prompt: threadPrompt(pr, request.thread, extra),
      }
    }
  }
}

function threadPrompt(pr: PullRequest, thread: ThreadFix, extra: string): string {
  const lines = [
    `Address this review thread on pull request #${pr.number}.`,
    '',
    'Verify the finding before changing anything. Read the comments, the diff and the surrounding code, and check whether the problem is real and still present.',
    'Then decide whether it is worth addressing in this pull request. A finding can be wrong, already handled, out of scope, or not worth the added complexity.',
    'Pushing back is a valid outcome. Do not make a change just because a reviewer asked for it.',
    'If the finding holds up and is worth fixing, make the change, run the relevant checks, and push it to the existing branch.',
    'If the request is ambiguous, or a correct fix is not clear, do not push. Explain what is unclear instead.',
    '',
    'Always reply on the review thread itself, not as a general pull request comment.',
    'Say what you found when you checked the finding and what you did about it: the change you made and the commit you pushed, or why you made no change.',
    'Then resolve the thread. That covers a pushed fix and a reasoned pushback alike.',
    'Leave it unresolved only when the reviewer needs to weigh in: you fixed part of it, the right call is a judgement only they can make, or something is unclear.',
  ]
  if (thread.id) {
    lines.push(
      '',
      `The thread's GitHub node ID is ${thread.id}. With the GitHub CLI:`,
      `- Reply: gh api graphql -f query='mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }' -f id=${thread.id} -f body='<reply>'`,
      `- Resolve: gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -f id=${thread.id}`,
    )
  }
  if (extra) lines.push('', 'Additional instructions:', extra)
  lines.push('', 'Review thread:', `- ${threadPlace(thread)}${thread.outdated ? ' (outdated)' : ''}`)
  if (thread.url) lines.push(`- ${thread.url}`)
  if (thread.diffHunk?.trim()) lines.push('', 'Diff:', '```diff', thread.diffHunk.trimEnd(), '```')
  const comments = thread.comments.filter((comment) => comment.body.trim())
  if (comments.length) {
    lines.push('', 'Comments:')
    for (const comment of comments) lines.push('', `${comment.author ?? 'Someone'}:`, comment.body.trim())
  }
  if (thread.truncated) lines.push('', 'Part of this thread was left out.')
  lines.push('', ...context(pr))
  return lines.join('\n')
}

function named(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

function restack(pr: PullRequest, upstack: PullRequest[]): string[] {
  if (upstack.length === 0) return []
  const one = upstack.length === 1
  return [
    '',
    `This pull request is part of a stack, and ${one ? 'one pull request is' : `${upstack.length} pull requests are`} stacked above it. Restack ${one ? 'it' : 'them'} once #${pr.number} is resolved, so the whole stack is left up to date:`,
    ...upstack.map((item) => `- #${item.number}: head branch ${item.headRef}, based on ${item.baseRef}`),
    '',
    `${one ? 'Rebase its head branch' : 'In that order, rebase each head branch'} onto the updated tip of the branch it is based on, so it carries only its own commits.`,
    'Resolve any conflict that comes up on the way, run the relevant checks, and push with `--force-with-lease`.',
    'Do not change the base branch of any pull request, and do not merge or close one.',
    'If a branch cannot be restacked cleanly, stop there, leave it and the branches above it as they are, and say which ones are left.',
  ]
}

function context(pr: PullRequest, upstack: PullRequest[] = []): string[] {
  const issues = pr.linearIssues.map((issue) => `- ${issue.identifier}${issue.title ? `: ${issue.title}` : ''}${issue.url ? ` (${issue.url})` : ''}`)
  return [
    'Pull request:',
    `- #${pr.number} in ${pr.repo}: ${pr.title}`,
    `- ${pr.url}`,
    `- Head branch ${pr.headRef}, base branch ${pr.baseRef}`,
    ...(issues.length ? ['', 'Linked issues:', ...issues] : []),
    '',
    upstack.length
      ? `Work on the existing head branches named above (${pr.headRef} first) and push only to them.`
      : `Work on the pull request's existing head branch (${pr.headRef}) and push any commits there.`,
    'Do not create a separate pull request.',
  ]
}

function headline(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}
