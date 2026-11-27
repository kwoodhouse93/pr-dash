export type Ruleset = {
  id?: number
  name?: string
  enforcement?: string
  /** Whether the person the token belongs to may merge past this ruleset. */
  current_user_can_bypass?: string
  rules?: {
    type?: string
    parameters?: {
      required_status_checks?: { context?: string }[]
      required_approving_review_count?: number
      dismiss_stale_reviews_on_push?: boolean
      require_last_push_approval?: boolean
      require_code_owner_review?: boolean
      required_reviewers?: unknown[]
    }
  }[]
}

export type ReviewPolicy = {
  requiredApprovals: number
  dismissStale: boolean
}

export const RULES_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function rulesFresh(fetchedAt: string | null | undefined, now: number, maxAge = RULES_MAX_AGE_MS): boolean {
  if (!fetchedAt) return false
  const at = Date.parse(fetchedAt)
  return !Number.isNaN(at) && now < at + maxAge
}

export function requiredCheckNames(rulesets: Ruleset[]): string[] {
  const names = new Set<string>()
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active') continue
    for (const rule of ruleset.rules ?? []) {
      if (rule.type !== 'required_status_checks') continue
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (check.context) names.add(check.context)
      }
    }
  }
  return [...names].sort()
}

/** Review rules that apply when a pull request targets the default branch. */
export function reviewPolicy(rulesets: Ruleset[]): ReviewPolicy {
  let requiredApprovals = 0
  let dismissStale = false
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active') continue
    for (const rule of ruleset.rules ?? []) {
      if (rule.type !== 'pull_request') continue
      const count = rule.parameters?.required_approving_review_count
      if (typeof count === 'number' && count > requiredApprovals) requiredApprovals = count
      if (rule.parameters?.dismiss_stale_reviews_on_push || rule.parameters?.require_last_push_approval) {
        dismissStale = true
      }
    }
  }
  return { requiredApprovals, dismissStale }
}

/** Rules the merge queue checks itself, or that a squash merge of a pull request cannot break. */
const CHECKED_RULES: ReadonlySet<string> = new Set([
  'pull_request',
  'required_status_checks',
  'deletion',
  'non_fast_forward',
  'creation',
  'required_linear_history',
  'copilot_code_review',
])

const CAN_BYPASS: ReadonlySet<string> = new Set(['always', 'pull_requests_only', 'exempt'])

/**
 * Why the viewer cannot merge a pull request that lacks its required review, or null when they can.
 * GitHub skips every rule in a ruleset the viewer bypasses, so a ruleset holding a rule the queue
 * does not check itself refuses the merge.
 */
export function reviewBypassBlock(rulesets: Ruleset[]): string | null {
  let reviewRules = 0
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active') continue
    const label = ruleset.name ? `the ruleset "${ruleset.name}"` : 'a ruleset'
    const allowed = CAN_BYPASS.has(ruleset.current_user_can_bypass ?? '')
    for (const rule of ruleset.rules ?? []) {
      if (allowed && !CHECKED_RULES.has(rule.type ?? '')) {
        return `Merging without approval would also skip a rule this app does not check (${rule.type ?? 'unknown'}, in ${label}).`
      }
      if (rule.type !== 'pull_request') continue
      const needs = rule.parameters
      const review =
        (needs?.required_approving_review_count ?? 0) > 0 || (needs?.required_reviewers?.length ?? 0) > 0 || needs?.require_code_owner_review === true
      if (!review) continue
      reviewRules += 1
      if (!allowed) return `You are not allowed to bypass ${label}.`
    }
  }
  return reviewRules > 0 ? null : 'No ruleset requires a review here, so there is no review rule to bypass.'
}
