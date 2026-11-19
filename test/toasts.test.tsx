import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { toastError, toastLinearHint, toastRerun, toastSyncWarning } from '../src/web/toasts.tsx'

vi.mock('sonner', () => {
  const make = () => vi.fn(() => 'id')
  return {
    Toaster: () => null,
    toast: { error: make(), warning: make(), info: make(), success: make(), dismiss: vi.fn() },
  }
})

type Shown = { heading: string; body: string; duration: number }

function shown(kind: 'error' | 'warning' | 'info' | 'success'): Shown {
  const call = vi.mocked(toast[kind]).mock.calls.at(-1) as unknown as [string, { description?: ReactElement; duration: number }]
  return { heading: call[0], body: call[1].description ? renderToStaticMarkup(call[1].description) : '', duration: call[1].duration }
}

describe('notices', () => {
  beforeEach(() => {
    for (const kind of ['error', 'warning', 'info', 'success', 'dismiss'] as const) vi.mocked(toast[kind]).mockClear()
  })

  it('puts what failed in the heading, the detail under it, and offers a retry', () => {
    toastError('GitHub returned 502', { heading: 'Refresh failed', onRetry: () => {} })
    const notice = shown('error')
    expect(notice.heading).toBe('Refresh failed')
    expect(notice.body).toContain('GitHub returned 502')
    expect(notice.body).toContain('Retry')
  })

  it('does not repeat a detail that only says the heading again', () => {
    toastError('Could not save that change', { heading: 'Could not save that change' })
    expect(shown('error').body).toBe('')
  })

  it('shows a paused refresh as when it resumes, not as an error', () => {
    toastError('GitHub GraphQL refreshes are paused until 19 Nov, 15:40 (120 points left).', { heading: 'Refresh failed', onRetry: () => {} })
    expect(toast.error).not.toHaveBeenCalled()
    const notice = shown('info')
    expect(notice.heading).toBe('Refreshes paused')
    expect(notice.body).toContain('Resumes 19 Nov, 15:40 (120 points left).')
    expect(notice.body).not.toContain('Retry')
  })

  it('lists each refresh problem on its own line and stays up until a clean refresh', () => {
    toastSyncWarning('acme/app#1 is missing checks; acme/app#2 is missing checks; Team review requests were not loaded.; Linear failed; One more', {
      onRetry: () => {},
      onSettings: () => {},
    })
    const notice = shown('warning')
    expect(notice.heading).toBe('Refresh finished with problems')
    expect(notice.body.match(/notice-line/g)).toHaveLength(3)
    expect(notice.body).toContain('and 2 more')
    expect(notice.duration).toBe(Infinity)
    toastSyncWarning(null, { onRetry: () => {}, onSettings: () => {} })
    expect(toast.dismiss).toHaveBeenCalledWith('snapshot-warning')
  })

  it('reports a clean rerun in one line and a partial one with its errors and a retry', () => {
    toastRerun({ reran: 1, errors: [] }, () => {})
    expect(shown('success').heading).toBe('Reran 1 workflow.')
    toastRerun({ reran: 2, errors: ['acme/app run 5: not found', 'acme/app run 6: forbidden'] }, () => {})
    const notice = shown('warning')
    expect(notice.heading).toBe('Reran 2 workflows, 2 could not be rerun')
    expect(notice.body).toContain('run 6: forbidden')
    expect(notice.body).toContain('Retry failed')
  })

  it('lets the Linear hint be hidden for good', () => {
    toastLinearHint(true, () => {})
    expect(shown('info').body).toContain('Don’t show again')
    toastLinearHint(false, () => {})
    expect(toast.dismiss).toHaveBeenCalledWith('linear-setup')
  })
})
