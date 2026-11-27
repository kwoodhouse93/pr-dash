import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/server/app.ts'
import { openDatabase } from '../src/server/db.ts'
import { SyncCancelled } from '../src/server/sync-queue.ts'
import { failure, PULL_GONE } from '../src/server/errors.ts'
import { SYNC_CANCELLED } from '../src/shared/sync.ts'

describe('api routes', () => {
  let dir = ''
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pr-dash-routes-'))
    app = createApp(openDatabase(path.join(dir, 'db.sqlite')), { loopbackOnly: true, address: 'http://127.0.0.1:4317' })
    vi.stubEnv('LINEAR_API_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  async function call(method: 'GET' | 'POST', route: string, body?: unknown) {
    const response = await app.request(route, {
      method,
      headers: { host: '127.0.0.1:4317', 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) } : {}),
    })
    return { status: response.status, body: (await response.json()) as { error?: string; code?: string } }
  }

  it('answers a read with what is stored', async () => {
    const { status, body } = await call('GET', '/api/snapshot')
    expect(status).toBe(200)
    expect(body).toMatchObject({ pullRequests: [], reviewPullRequests: [] })
  })

  it("takes T3 Code's answer to a sign-in from T3 Code's own page, and turns down one it did not start", async () => {
    // The browser arrives from T3 Code's page, which the API itself refuses as another site.
    const headers = { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site' }
    expect((await app.request('/api/agents', { headers })).status).toBe(403)
    const answered = await app.request('/agents/t3/connected?code=abc&state=not-started-here', { headers })
    expect(answered.status).toBe(400)
    expect(await answered.text()).toMatch(/could not connect to T3 Code.*was not started here/s)
    const denied = await app.request('/agents/t3/connected?error=access_denied', { headers })
    expect(await denied.text()).toMatch(/turned down in T3 Code/)
  })

  it('only signs in to T3 Code for a dashboard on this machine', async () => {
    const open = createApp(openDatabase(path.join(dir, 'open.sqlite')), { loopbackOnly: false, address: 'http://0.0.0.0:4317' })
    const response = await open.request('/api/agents/t3/connect', { method: 'POST', headers: { host: 'dash.example:4317' }, body: '{}' })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toMatch(/only offered when the dashboard runs on this machine/)
  })

  it('says what a request is missing, whatever its body', async () => {
    expect(await call('POST', '/api/pulls/refresh')).toEqual({ status: 400, body: { error: 'A pull request is required.' } })
    expect(await call('POST', '/api/pulls/refresh', 'not json')).toEqual({ status: 400, body: { error: 'A pull request is required.' } })
    expect((await call('POST', '/api/repos')).body.error).toMatch(/owner\/name/)
    expect((await call('POST', '/api/initiatives')).body.error).toMatch(/1–80 characters/)
    expect(await call('POST', '/api/sync')).toMatchObject({ status: 400 })
    expect((await call('POST', '/api/linear/links', { key: 'a', identifier: 'ENG-1' })).body.error).toMatch(/LINEAR_API_KEY/)
  })

  it('turns a refusal thrown from below into its status', async () => {
    expect(await call('GET', '/api/feedback?key=gone')).toEqual({ status: 404, body: { error: PULL_GONE } })
    expect(await call('POST', '/api/merge-queue', { key: 'gone' })).toMatchObject({ status: 409, body: { error: PULL_GONE } })
    expect(await call('POST', '/api/merge-queue/none/cancel')).toMatchObject({ status: 404 })
    await call('POST', '/api/initiatives', { name: 'Billing' })
    expect(await call('POST', '/api/initiatives', { name: 'billing' })).toMatchObject({ status: 409 })
  })

  it('refuses a page on another site before any route runs', async () => {
    const response = await app.request('/api/snapshot', { headers: { host: '127.0.0.1:4317', origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
  })

  it('marks a cancelled refresh with a code, and anything unexpected as an upstream failure', () => {
    expect(failure(new SyncCancelled())).toEqual({ status: 409, body: { error: 'Sync cancelled', code: SYNC_CANCELLED } })
    expect(failure(new Error('GitHub is down'))).toEqual({ status: 502, body: { error: 'GitHub is down' } })
    expect(failure('nonsense')).toEqual({ status: 502, body: { error: 'Request failed' } })
  })
})
