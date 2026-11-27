// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { loadPreferences, locationSearch, savePreferences, withLocation } from '../src/web/prefs.ts'

afterEach(() => localStorage.clear())

describe('dashboard preferences', () => {
  it('keeps list preferences separate for each tab', () => {
    const prefs = loadPreferences()
    prefs.views.mine.filters.query = 'mine only'
    prefs.views.mine.flat = ['project:Updates']
    prefs.views.review.filters.awaitingOnly = true
    savePreferences(prefs)

    const loaded = loadPreferences()
    expect(loaded.views.mine.filters.query).toBe('mine only')
    expect(loaded.views.mine.filters.awaitingOnly).toBe(false)
    expect(loaded.views.mine.flat).toEqual(['project:Updates'])
    expect(loaded.views.review.filters.query).toBe('')
    expect(loaded.views.review.filters.awaitingOnly).toBe(true)
    expect(loaded.views.review.flat).toEqual([])
  })

  it('keeps the pull request link host, and defaults to GitHub', () => {
    expect(loadPreferences().prLinks).toBe('github')
    const prefs = loadPreferences()
    prefs.prLinks = 'graphite'
    savePreferences(prefs)
    expect(loadPreferences().prLinks).toBe('graphite')

    localStorage.setItem('pr-dash.preferences.v1', JSON.stringify({ prLinks: 'elsewhere', page: 'mine' }))
    expect(loadPreferences().prLinks).toBe('github')
  })

  it('keeps the theme, and starts in the default for a name it does not know', () => {
    expect(loadPreferences().theme).toBe('ember')
    savePreferences({ ...loadPreferences(), theme: 'paper' })
    expect(loadPreferences().theme).toBe('paper')
    localStorage.setItem('pr-dash.preferences.v1', JSON.stringify({ theme: 'neon' }))
    expect(loadPreferences().theme).toBe('ember')
  })

  it('leaves animations to the system until told otherwise, and keeps the choice', () => {
    expect(loadPreferences().animations).toBe('system')
    savePreferences({ ...loadPreferences(), animations: 'off' })
    expect(loadPreferences().animations).toBe('off')
    savePreferences({ ...loadPreferences(), animations: 'sometimes' as never })
    expect(loadPreferences().animations).toBe('system')
  })

  it('keeps button sounds off once switched off, and starts with them on', () => {
    expect(loadPreferences().sounds).toBe(true)
    savePreferences({ ...loadPreferences(), sounds: false })
    expect(loadPreferences().sounds).toBe(false)
  })

  it('writes the page and its filters to the address, and leaves defaults out', () => {
    const prefs = loadPreferences()
    expect(locationSearch(prefs)).toBe('')

    prefs.page = 'review'
    prefs.views.review.filters = { ...prefs.views.review.filters, query: 'retry hook', repo: 'acme/app', ci: 'red', awaitingOnly: true }
    prefs.views.mine.filters.hideDrafts = true
    expect(locationSearch(prefs)).toBe('?view=review&q=retry+hook&repo=acme%2Fapp&ci=red&awaiting=1')

    prefs.page = 'settings'
    expect(locationSearch(prefs)).toBe('?view=settings')
  })

  it('opens the list an address describes, whatever was saved', () => {
    const saved = loadPreferences()
    saved.page = 'queue'
    saved.views.review.filters.hideDrafts = true
    saved.views.review.flat = ['band:loose']

    const opened = withLocation(saved, '?view=review&q=retry+hook&repo=acme%2Fapp&ci=red&awaiting=1')
    expect(opened.page).toBe('review')
    expect(opened.views.review.filters).toEqual({
      query: 'retry hook',
      repo: 'acme/app',
      hideDrafts: false,
      ci: 'red',
      review: 'all',
      approvedByMe: 'all',
      awaitingOnly: true,
      initiativeId: null,
    })
    expect(opened.views.review.flat).toEqual(['band:loose'])
    expect(locationSearch(opened)).toBe('?view=review&q=retry+hook&repo=acme%2Fapp&ci=red&awaiting=1')

    expect(withLocation(saved, '?drafts=hide').page).toBe('mine')
    expect(withLocation(saved, '?drafts=hide').views.mine.filters.hideDrafts).toBe(true)
  })

  it('keeps saved preferences for a bare address, and ignores values it does not know', () => {
    const saved = loadPreferences()
    saved.page = 'review'
    saved.views.review.filters.ci = 'green'

    expect(withLocation(saved, '')).toBe(saved)
    expect(withLocation(saved, '?view=nowhere')).toBe(saved)
    expect(withLocation(saved, '?view=mine').views.review.filters.ci).toBe('green')

    const odd = withLocation(saved, '?view=review&ci=purple&review=maybe&approved=sometimes')
    expect(odd.views.review.filters.ci).toBe('all')
    expect(odd.views.review.filters.review).toBe('all')
    expect(odd.views.review.filters.approvedByMe).toBe('all')
  })
})
