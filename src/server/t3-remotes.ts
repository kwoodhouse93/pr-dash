import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { databasePath } from './db.ts'

/**
 * What PR Dash has been told about reaching another machine's T3 Code, for each linked environment:
 * the address its pages are at, and the SSH login a pairing link for it is made through.
 * T3 Code's own tools name an environment without saying where its pages are, so this is kept here.
 */
export type T3Remote = { origin: string; ssh: string }

function remotesFile(): string {
  return path.join(path.dirname(databasePath()), 't3-environments.json')
}

export function readRemotes(file = remotesFile()): Record<string, T3Remote> {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<T3Remote>>
    return Object.fromEntries(
      Object.entries(saved).flatMap(([id, remote]) =>
        typeof remote?.origin === 'string' && typeof remote.ssh === 'string' ? [[id, { origin: remote.origin, ssh: remote.ssh }]] : [],
      ),
    )
  } catch {
    return {}
  }
}

export function saveRemote(environmentId: string, remote: T3Remote, file = remotesFile()): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...readRemotes(file), [environmentId]: remote }))
}
