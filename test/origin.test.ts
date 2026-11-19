import { describe, expect, it } from 'vitest'
import { refusal } from '../src/server/origin.ts'

describe('api origin check', () => {
  it('allows the dashboard, the dev proxy and clients that are not browsers', () => {
    expect(refusal({ host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', secFetchSite: 'same-origin' }, true)).toBeNull()
    expect(refusal({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', secFetchSite: 'same-origin' }, true)).toBeNull()
    expect(refusal({ host: 'localhost:4318', secFetchSite: 'same-origin' }, true)).toBeNull()
    expect(refusal({ host: '[::1]:4317', origin: 'http://[::1]:4317' }, true)).toBeNull()
    expect(refusal({ host: '127.0.0.1:4317' }, true)).toBeNull()
    expect(refusal({ host: '127.0.0.1:4317', secFetchSite: 'none' }, true)).toBeNull()
  })

  it('refuses a page on another site', () => {
    expect(refusal({ host: '127.0.0.1:4317', origin: 'https://evil.example', secFetchSite: 'cross-site' }, true)).toMatch(/another site/)
    expect(refusal({ host: '127.0.0.1:4317', origin: 'https://evil.example' }, true)).toMatch(/another site/)
    expect(refusal({ host: '127.0.0.1:4317', secFetchSite: 'cross-site' }, true)).toMatch(/another site/)
    expect(refusal({ host: '127.0.0.1:4317', origin: 'null' }, true)).toMatch(/another site/)
  })

  it('refuses another port or name on this machine', () => {
    expect(refusal({ host: '127.0.0.1:4317', origin: 'http://127.0.0.1:3000', secFetchSite: 'same-site' }, true)).toMatch(/another site/)
    expect(refusal({ host: '127.0.0.1:4317', origin: 'http://localhost:4317' }, true)).toMatch(/another site/)
  })

  it('refuses a rebound name when the server is local', () => {
    expect(refusal({ host: 'evil.example:4317', origin: 'http://evil.example:4317', secFetchSite: 'same-origin' }, true)).toMatch(/local address/)
    expect(refusal({}, true)).toMatch(/Host/)
    expect(refusal({ host: 'a b' }, true)).toMatch(/Host/)
  })

  it('keeps the same-site rule on a deployed server and accepts its own name', () => {
    expect(refusal({ host: 'dash.internal:4317', origin: 'http://dash.internal:4317', secFetchSite: 'same-origin' }, false)).toBeNull()
    expect(refusal({ host: 'dash.internal', origin: 'https://dash.internal' }, false)).toBeNull()
    expect(refusal({ host: 'dash.internal:4317', origin: 'https://evil.example' }, false)).toMatch(/another site/)
  })
})
