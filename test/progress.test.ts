import { describe, expect, it } from 'vitest'
import { refreshSteps, stepIndex } from '../src/shared/progress.ts'

describe('refresh steps', () => {
  it('advances once per finished step and stays put inside a step', () => {
    const steps = refreshSteps(false, true)
    expect(steps).toEqual(['list', 'checks', 'issues', 'cursor', 'threads'])
    let at = 0
    at = stepIndex(steps, at, 'Starting refresh')
    at = stepIndex(steps, at, 'Fetching your pull requests')
    at = stepIndex(steps, at, 'Fetching your pull requests (12 so far)')
    expect(at).toBe(0)
    at = stepIndex(steps, at, 'Fetching checks 4 of 12')
    at = stepIndex(steps, at, 'Reading required checks for acme/app')
    expect(at).toBe(1)
    at = stepIndex(steps, at, 'Reading Linear projects')
    expect(at).toBe(2)
    at = stepIndex(steps, at, 'Checking Cursor')
    expect(at).toBe(3)
    at = stepIndex(steps, at, 'Reading thread replies (8 of 20)')
    at = stepIndex(steps, at, 'Reading thread replies (4 of 12)')
    expect(at).toBe(4)
  })

  it('walks both lists on a full sync and can skip a step that never reports', () => {
    const steps = refreshSteps(true, false)
    expect(steps).toEqual(['list', 'checks', 'list', 'checks', 'cursor', 'threads'])
    let at = 0
    at = stepIndex(steps, at, 'Fetching pull requests to review (3 so far)')
    at = stepIndex(steps, at, 'Fetching checks 1 of 2')
    expect(at).toBe(1)
    at = stepIndex(steps, at, 'Fetching your pull requests')
    expect(at).toBe(2)
    at = stepIndex(steps, at, 'Checking Cursor')
    expect(at).toBe(4)
    at = stepIndex(steps, at, 'Fetching checks 1 of 2')
    expect(at).toBe(4)
  })
})