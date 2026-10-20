import type { Check, CiLevel } from './types.ts'

const FAIL = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
])

const SUCCESS = new Set(['SUCCESS', 'NEUTRAL'])

const PENDING_STATUS = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'])

export type CheckPhase = 'fail' | 'pending' | 'success' | 'skip'

export function checkPhase(check: Check): CheckPhase {
  const conclusion = (check.conclusion ?? '').toUpperCase()
  const status = (check.status ?? '').toUpperCase()
  if (conclusion === 'SKIPPED' || conclusion === 'STALE') return 'skip'
  if (FAIL.has(conclusion)) return 'fail'
  if (SUCCESS.has(conclusion)) return 'success'
  if (conclusion === 'PENDING' || PENDING_STATUS.has(status) || status !== 'COMPLETED') return 'pending'
  return 'pending'
}

function stamp(check: Check): number {
  const raw = check.completedAt ?? check.startedAt
  return raw ? Date.parse(raw) : 0
}

/** Latest non-skipped run of each check name. A newer skip drops the check. */
export function selectChecks(checks: Check[]): Check[] {
  const groups = new Map<string, Check[]>()
  for (const check of checks) {
    const list = groups.get(check.name) ?? []
    list.push(check)
    groups.set(check.name, list)
  }
  const selected: Check[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => stamp(b) - stamp(a))
    const latest = group[0]
    if (!latest || checkPhase(latest) === 'skip') continue
    selected.push(latest)
  }
  selected.sort((a, b) => a.name.localeCompare(b.name))
  return selected
}

export function applyRequired(checks: Check[], requiredNames: string[]): Check[] {
  const names = new Set(requiredNames)
  return checks.map((check) => ({
    ...check,
    required: check.required || names.has(check.name),
  }))
}

const SEVERITY: CiLevel[] = ['red', 'yellow', 'pending', 'green', 'none']

export function worstCi(levels: CiLevel[]): CiLevel {
  return SEVERITY.find((level) => levels.includes(level)) ?? 'none'
}

/**
 * Red: a required check failed.
 * Yellow: required checks are not failing, and an optional check failed.
 * Pending: nothing has failed, and a check is still running.
 * Green: every selected check succeeded.
 */
export function ciLevel(checks: Check[]): CiLevel {
  const selected = selectChecks(checks)
  if (selected.length === 0) return 'none'
  const required = selected.filter((check) => check.required)
  const optional = selected.filter((check) => !check.required)
  if (required.some((check) => checkPhase(check) === 'fail')) return 'red'
  if (optional.some((check) => checkPhase(check) === 'fail')) return 'yellow'
  if (selected.some((check) => checkPhase(check) === 'pending')) return 'pending'
  if (selected.every((check) => checkPhase(check) === 'success')) return 'green'
  return 'pending'
}

export function ciLabel(level: CiLevel): string {
  switch (level) {
    case 'red':
      return 'Failed'
    case 'yellow':
      return 'Optional failed'
    case 'pending':
      return 'Running'
    case 'green':
      return 'Passed'
    case 'none':
      return 'No CI'
  }
}

export function ciDetail(level: CiLevel): string {
  switch (level) {
    case 'red':
      return 'A required check failed.'
    case 'yellow':
      return 'Required checks passed, or none apply. An optional check failed.'
    case 'pending':
      return 'A check is still running.'
    case 'green':
      return 'Every check passed.'
    case 'none':
      return 'No checks on the latest commit.'
  }
}
