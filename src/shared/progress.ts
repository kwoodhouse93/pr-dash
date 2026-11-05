export type RefreshStep = 'list' | 'checks' | 'issues' | 'cursor' | 'threads'

export function refreshSteps(full: boolean, linear: boolean): RefreshStep[] {
  const pass: RefreshStep[] = linear ? ['list', 'checks', 'issues'] : ['list', 'checks']
  return [...(full ? [...pass, ...pass] : pass), 'cursor', 'threads']
}

export function refreshStep(message: string): RefreshStep | null {
  if (message.startsWith('Fetching your pull requests') || message.startsWith('Fetching pull requests to review')) return 'list'
  if (
    message.startsWith('Fetching checks') ||
    message.startsWith('Reading required checks') ||
    message.startsWith('Comparing checks') ||
    message.startsWith('Checks unchanged')
  ) {
    return 'checks'
  }
  if (message.startsWith('Reading Linear')) return 'issues'
  if (message.startsWith('Checking Cursor')) return 'cursor'
  if (message.startsWith('Reading thread replies')) return 'threads'
  return null
}

/** Index of the step in progress. Steps before this index are finished. */
export function stepIndex(steps: RefreshStep[], current: number, message: string): number {
  const phase = refreshStep(message)
  if (!phase) return current
  if (steps[current] === phase) return current
  const index = steps.indexOf(phase, current)
  return index < 0 ? current : index
}
