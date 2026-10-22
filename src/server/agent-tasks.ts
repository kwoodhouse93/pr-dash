import { failingChecks, threadPlace, type AgentRequest, type ThreadFix } from '../shared/agents.ts'
import type { PullRequest } from '../shared/types.ts'

export type AgentTask = { name: string; prompt: string }

export function agentTask(pr: PullRequest, request: AgentRequest): AgentTask {
  switch (request.kind) {
    case 'conflict':
      return {
        name: `Resolve #${pr.number} merge conflict`,
        prompt: [
          `Resolve the merge conflict on pull request #${pr.number}.`,
          'Bring in its base branch, preserve the intended changes from both sides, run relevant checks, and push the resolution.',
          '',
          ...context(pr),
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
    `Fix the issue raised in this review thread on pull request #${pr.number}.`,
    'Read the comments and the diff, make the change they ask for, run the relevant checks, and push it to the existing branch.',
    'If the request is ambiguous, or a correct fix is not clear, do not push. Explain what is unclear instead.',
  ]
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

function context(pr: PullRequest): string[] {
  const issues = pr.linearIssues.map((issue) => `- ${issue.identifier}${issue.title ? `: ${issue.title}` : ''}${issue.url ? ` (${issue.url})` : ''}`)
  return [
    'Pull request:',
    `- #${pr.number} in ${pr.repo}: ${pr.title}`,
    `- ${pr.url}`,
    `- Head branch ${pr.headRef}, base branch ${pr.baseRef}`,
    ...(issues.length ? ['', 'Linked issues:', ...issues] : []),
    '',
    `Work on the pull request's existing head branch (${pr.headRef}) and push any commits there.`,
    'Do not create a separate pull request.',
  ]
}

function headline(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}
