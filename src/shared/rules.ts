type Ruleset = {
  enforcement?: string
  rules?: {
    type?: string
    parameters?: {
      required_status_checks?: { context?: string }[]
      required_approving_review_count?: number
      dismiss_stale_reviews_on_push?: boolean
      require_last_push_approval?: boolean
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
