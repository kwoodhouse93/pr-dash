import { afterEach, describe, expect, it, vi } from 'vitest'
import { markPullReadyForReview } from '../src/server/github.ts'

function githubResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('markPullReadyForReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks the pull request ready through the GraphQL mutation', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.github.com/graphql')
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } }
      expect(body.query).toContain('markPullRequestReadyForReview')
      expect(body.variables).toEqual({ id: 'PR_node' })
      return githubResponse({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await markPullReadyForReview('token', 'PR_node')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fails when GitHub reports the pull request is still a draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        githubResponse({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } },
        }),
      ),
    )

    await expect(markPullReadyForReview('token', 'PR_node')).rejects.toThrow(/draft/i)
  })

  it('surfaces a GraphQL error instead of treating it as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        githubResponse({
          errors: [{ message: 'Resource not accessible by integration' }],
        }),
      ),
    )

    await expect(markPullReadyForReview('token', 'PR_node')).rejects.toThrow('Resource not accessible by integration')
  })
})
