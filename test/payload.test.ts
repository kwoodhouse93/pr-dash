import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickPayload, readPayload, type Payload } from '../desktop/src/payload.ts'

function payloadDir(version: unknown, withServer = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'payload-'))
  mkdirSync(dir, { recursive: true })
  if (withServer) writeFileSync(path.join(dir, 'server.mjs'), '')
  writeFileSync(path.join(dir, 'version.json'), JSON.stringify(version))
  return dir
}

const older: Payload = { dir: '/a', sha: 'a', builtAt: '2026-11-01T00:00:00.000Z' }
const newer: Payload = { dir: '/b', sha: 'b', builtAt: '2026-11-02T00:00:00.000Z' }

describe('desktop payload', () => {
  it('reads a complete payload', () => {
    const dir = payloadDir({ sha: 'abc', builtAt: older.builtAt })
    expect(readPayload(dir)).toEqual({ dir, sha: 'abc', builtAt: older.builtAt })
  })

  it('rejects a payload with no server or a bad version stamp', () => {
    expect(readPayload(payloadDir({ sha: 'abc', builtAt: older.builtAt }, false))).toBeNull()
    expect(readPayload(payloadDir({ sha: 'abc', builtAt: 'yesterday' }))).toBeNull()
    expect(readPayload(payloadDir({ builtAt: older.builtAt }))).toBeNull()
  })

  it('runs the download only when it is newer than the one the app shipped with', () => {
    expect(pickPayload(older, newer)).toBe(newer)
    expect(pickPayload(newer, older)).toBe(newer)
    expect(pickPayload(older, null)).toBe(older)
    expect(pickPayload(null, newer)).toBe(newer)
    expect(pickPayload(null, null)).toBeNull()
  })
})
