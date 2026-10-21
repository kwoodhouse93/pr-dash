import type { Check, CiLevel, PullRequest } from './types.ts'

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
 * Pending: a required check is still running. With no required checks, any running check counts.
 * Green: every required check succeeded. A running optional check does not hold this back.
 */
export function ciLevel(checks: Check[]): CiLevel {
  const selected = selectChecks(checks)
  if (selected.length === 0) return 'none'
  const required = selected.filter((check) => check.required)
  const optional = selected.filter((check) => !check.required)
  if (required.some((check) => checkPhase(check) === 'fail')) return 'red'
  if (optional.some((check) => checkPhase(check) === 'fail')) return 'yellow'
  if (required.some((check) => checkPhase(check) === 'pending')) return 'pending'
  if (required.length === 0 && optional.some((check) => checkPhase(check) === 'pending')) return 'pending'
  if (required.length > 0 && required.every((check) => checkPhase(check) === 'success')) return 'green'
  if (selected.every((check) => checkPhase(check) === 'success')) return 'green'
  return 'pending'
}

export type CiDisplay = CiLevel | 'invalidated'

/** Identity of the check run currently on screen. A refresh that still returns this has not picked up a rerun. */
export function checkStamp(check: Check): string {
  return [check.status ?? '', check.conclusion ?? '', check.startedAt ?? '', check.completedAt ?? '', String(check.workflowRunId ?? '')].join('\0')
}

export type CheckHold = { name: string; stamp: string }

/**
 * Visible workflow checks a rerun would restart.
 * `runs` is null before GitHub answers, then the set of `repo#runId` keys that actually reran.
 */
export function holdsFor(checks: Check[], mode: 'failed' | 'all', runs: ReadonlySet<string> | null, repo: string): CheckHold[] {
  return selectChecks(checks).flatMap((check) => {
    if (check.workflowRunId == null) return []
    if (runs && !runs.has(`${repo}#${check.workflowRunId}`)) return []
    if (mode === 'failed' && checkPhase(check) !== 'fail') return []
    return [{ name: check.name, stamp: checkStamp(check) }]
  })
}

export function collectHolds(prs: PullRequest[], mode: 'failed' | 'all', runs: ReadonlySet<string> | null): Map<string, CheckHold[]> {
  const next = new Map<string, CheckHold[]>()
  for (const pr of prs) {
    const holds = holdsFor(pr.checks, mode, runs, pr.repo)
    if (holds.length > 0) next.set(pr.key, holds)
  }
  return next
}

export function mergeHolds(current: Map<string, CheckHold[]>, extra: Map<string, CheckHold[]>): Map<string, CheckHold[]> {
  const next = new Map(current)
  for (const [key, list] of extra) {
    const merged = new Map((next.get(key) ?? []).map((hold) => [hold.name, hold]))
    for (const hold of list) merged.set(hold.name, hold)
    next.set(key, [...merged.values()])
  }
  return next
}

export function withoutHolds(current: Map<string, CheckHold[]>, extra: Map<string, CheckHold[]>): Map<string, CheckHold[]> {
  const next = new Map(current)
  for (const [key, list] of extra) {
    const drop = new Set(list.map((hold) => hold.name))
    const kept = (next.get(key) ?? []).filter((hold) => !drop.has(hold.name))
    if (kept.length === 0) next.delete(key)
    else next.set(key, kept)
  }
  return next
}

/** Drop holds once the stored run is no longer the one on screen. */
export function reconcileHolds(holds: CheckHold[], checks: Check[]): CheckHold[] {
  const stamps = new Map(selectChecks(checks).map((check) => [check.name, checkStamp(check)]))
  return holds.filter((hold) => stamps.get(hold.name) === hold.stamp)
}

export function activeHoldNames(checks: Check[], holds: CheckHold[]): Set<string> {
  const wanted = new Map(holds.map((hold) => [hold.name, hold.stamp]))
  const names = new Set<string>()
  for (const check of selectChecks(checks)) {
    if (wanted.get(check.name) === checkStamp(check)) names.add(check.name)
  }
  return names
}

/**
 * A rerun hides the previous result. A required or optional failure that was not rerun still shows.
 * Green, pending, and empty rollups wait until the refresh reports the new run.
 */
export function displayCi(checks: Check[], invalidated: ReadonlySet<string>): CiDisplay {
  const selected = selectChecks(checks)
  const live = selected.filter((check) => !invalidated.has(check.name))
  if (live.length === selected.length) return ciLevel(selected)
  const liveLevel = ciLevel(live)
  if (liveLevel === 'red' || liveLevel === 'yellow') return liveLevel
  return 'invalidated'
}

const DISPLAY_SEVERITY: CiDisplay[] = ['red', 'yellow', 'invalidated', 'pending', 'green', 'none']

export function worstDisplay(levels: CiDisplay[]): CiDisplay {
  return DISPLAY_SEVERITY.find((level) => levels.includes(level)) ?? 'none'
}

export function ciLabel(level: CiDisplay): string {
  switch (level) {
    case 'red':
      return 'Failed'
    case 'yellow':
      return 'Optional failed'
    case 'invalidated':
      return 'Invalidated'
    case 'pending':
      return 'Running'
    case 'green':
      return 'Passed'
    case 'none':
      return 'No CI'
  }
}

const PHASE_ORDER: Record<CheckPhase, number> = { fail: 0, pending: 1, success: 2, skip: 3 }

/** Failing checks first, so a short tooltip shows why CI is not green. */
export function compareChecks(a: Check, b: Check): number {
  const phase = PHASE_ORDER[checkPhase(a)] - PHASE_ORDER[checkPhase(b)]
  if (phase !== 0) return phase
  if (a.required !== b.required) return a.required ? -1 : 1
  const workflow = (a.workflowName ?? '').localeCompare(b.workflowName ?? '')
  if (workflow !== 0) return workflow
  return a.name.localeCompare(b.name)
}

export function ciDetail(level: CiDisplay): string {
  switch (level) {
    case 'red':
      return 'A required check failed.'
    case 'yellow':
      return 'Required checks passed, or none apply. An optional check failed.'
    case 'invalidated':
      return 'Rerun requested. The previous result stays hidden until a refresh reports the new run.'
    case 'pending':
      return 'A check is still running.'
    case 'green':
      return 'Required checks passed.'
    case 'none':
      return 'No checks on the latest commit.'
  }
}
