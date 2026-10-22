// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { loadPreferences, savePreferences } from '../src/web/prefs.ts'

afterEach(() => localStorage.clear())

describe('dashboard preferences', () => {
  it('keeps list preferences separate for each tab', () => {
    const prefs = loadPreferences()
    prefs.views.mine.filters.query = 'mine only'
    prefs.views.mine.byIssue = false
    prefs.views.review.filters.awaitingOnly = true
    savePreferences(prefs)

    const loaded = loadPreferences()
    expect(loaded.views.mine.filters.query).toBe('mine only')
    expect(loaded.views.mine.filters.awaitingOnly).toBe(false)
    expect(loaded.views.mine.byIssue).toBe(false)
    expect(loaded.views.review.filters.query).toBe('')
    expect(loaded.views.review.filters.awaitingOnly).toBe(true)
    expect(loaded.views.review.byIssue).toBe(true)
  })

  it('copies legacy shared filters into both tabs', () => {
    localStorage.setItem('pr-dash.preferences.v1', JSON.stringify({
      filters: { repo: 'acme/app', review: 'unmet' },
      byIssue: false,
      page: 'review',
    }))

    const loaded = loadPreferences()
    expect(loaded.views.mine.filters.repo).toBe('acme/app')
    expect(loaded.views.review.filters.repo).toBe('acme/app')
    expect(loaded.views.mine.filters.review).toBe('unmet')
    expect(loaded.views.review.filters.review).toBe('unmet')
    expect(loaded.views.mine.byIssue).toBe(false)
    expect(loaded.views.review.byIssue).toBe(false)
  })
})
