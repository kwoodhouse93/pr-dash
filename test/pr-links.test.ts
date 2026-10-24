import { describe, expect, it } from 'vitest'
import { noteAnchor, prHref, threadAnchor } from '../src/web/pr-links.tsx'

const pull = 'https://github.com/acme/app/pull/7'
const threadUrl = 'https://github.com/acme/app/pull/7#discussion_r42'
const commentUrl = 'https://github.com/acme/app/pull/7#issuecomment-9'
const reviewUrl = 'https://github.com/acme/app/pull/7#pullrequestreview-3'

describe('pull request links', () => {
  it('leaves GitHub links alone, including the Open column urls passed through unchanged', () => {
    expect(prHref(pull, 'github')).toBe(pull)
    expect(prHref(threadUrl, 'github', { kind: 'comment', id: 'PRRC_kwDO' })).toBe(threadUrl)
    expect(prHref('https://github.com/acme/app/actions/runs/9', 'graphite')).toBe('https://github.com/acme/app/actions/runs/9')
  })

  it('sends a pull request page to Graphite', () => {
    expect(prHref(pull, 'graphite')).toBe('https://app.graphite.com/github/pr/acme/app/7')
    expect(prHref('https://github.com/acme/app/pull/7/files', 'graphite')).toBe('https://app.graphite.com/github/pr/acme/app/7')
  })

  it('keeps a GitHub comment hash when there is no Graphite id to attach', () => {
    expect(prHref(threadUrl, 'graphite')).toBe(threadUrl)
    expect(prHref(commentUrl, 'graphite')).toBe(commentUrl)
    expect(prHref(reviewUrl, 'graphite')).toBe(reviewUrl)
    expect(prHref('https://github.com/acme/app/pull/7/files#r42', 'graphite')).toBe('https://github.com/acme/app/pull/7/files#r42')
  })

  it('opens Graphite on the matching thread, comment, discussion, or review', () => {
    expect(prHref(threadUrl, 'graphite', { kind: 'comment', id: 'PRRC_kwDOAbc' })).toBe(
      'https://app.graphite.com/github/pr/acme/app/7/changes#comment-PRRC_kwDOAbc',
    )
    expect(prHref(pull, 'graphite', { kind: 'thread', id: 'PRRT_kwDOAbc' })).toBe(
      'https://app.graphite.com/github/pr/acme/app/7/changes#thread-PRRT_kwDOAbc',
    )
    expect(prHref(commentUrl, 'graphite', { kind: 'discussion', id: 'IC_kwDOAbc' })).toBe(
      'https://app.graphite.com/github/pr/acme/app/7/activity#discussion-IC_kwDOAbc',
    )
    expect(prHref(reviewUrl, 'graphite', { kind: 'review', id: 'PRR_kwDOAbc' })).toBe(
      'https://app.graphite.com/github/pr/acme/app/7/activity#review-PRR_kwDOAbc',
    )
  })

  it('points a thread at its latest reply, and a note at the discussion or review', () => {
    expect(threadAnchor({ id: 'PRRT_thread', comments: [{ id: 'PRRC_old' }, { id: 'PRRC_new' }] })).toEqual({
      kind: 'comment',
      id: 'PRRC_new',
    })
    expect(threadAnchor({ id: 'PRRT_thread', comments: [] })).toEqual({ kind: 'thread', id: 'PRRT_thread' })
    expect(noteAnchor({ id: 'IC_note', kind: 'comment' })).toEqual({ kind: 'discussion', id: 'IC_note' })
    expect(noteAnchor({ id: 'PRR_note', kind: 'review' })).toEqual({ kind: 'review', id: 'PRR_note' })
  })
})
