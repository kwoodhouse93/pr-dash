import type { PullRequest } from './types.ts'

const READY: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

export function canSquashMerge(pr: PullRequest): boolean {
  return (
    pr.squashMergeAllowed === true &&
    typeof pr.defaultBranch === 'string' &&
    pr.defaultBranch.length > 0 &&
    pr.baseRef === pr.defaultBranch &&
    !pr.isDraft &&
    pr.mergeable === 'MERGEABLE' &&
    READY.has(pr.mergeStateStatus ?? '') &&
    pr.unresolvedCount === 0
  )
}
