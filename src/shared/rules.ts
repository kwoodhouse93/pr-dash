type Ruleset = {
  enforcement?: string
  rules?: { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[]
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
