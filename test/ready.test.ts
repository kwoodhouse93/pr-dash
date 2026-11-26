import { afterEach, describe, expect, it, vi } from 'vitest'
import { markPullReadyForReview, squashMergePullRequest } from '../src/server/github.ts'

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

describe('squashMergePullRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('merges only the head that was checked', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.github.com/repos/acme/app/pulls/7/merge')
      expect(JSON.parse(String(init?.body))).toEqual({ merge_method: 'squash', sha: 'abc' })
      return githubResponse({ merged: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await squashMergePullRequest('token', 'acme/app', 7, 'abc')).toBe('merged')
  })

  it('reports a head that moved without merging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => githubResponse({ message: 'Head branch was modified. Review and try the merge again.' }, 409)))
    expect(await squashMergePullRequest('token', 'acme/app', 7, 'abc')).toBe('moved')
  })

  it('fails with the reason GitHub gives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => githubResponse({ message: 'Repository rule violations found' }, 405)))
    await expect(squashMergePullRequest('token', 'acme/app', 7, 'abc')).rejects.toThrow('Repository rule violations found')
  })
})
