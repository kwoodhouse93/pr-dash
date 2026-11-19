import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// A payload is a directory holding server.mjs, dist/web and version.json.
export type Payload = { dir: string; sha: string; builtAt: string }

export function readPayload(dir: string): Payload | null {
  try {
    if (!existsSync(path.join(dir, 'server.mjs'))) return null
    const version = JSON.parse(readFileSync(path.join(dir, 'version.json'), 'utf8')) as { sha?: unknown; builtAt?: unknown }
    if (typeof version.sha !== 'string' || typeof version.builtAt !== 'string') return null
    if (Number.isNaN(Date.parse(version.builtAt))) return null
    return { dir, sha: version.sha, builtAt: version.builtAt }
  } catch {
    return null
  }
}

export function isNewer(candidate: Payload, than: Payload): boolean {
  return Date.parse(candidate.builtAt) > Date.parse(than.builtAt)
}

// The app ships with a payload and downloads later ones. A rebuilt app can
// carry a newer payload than the last download, so take whichever is newer.
export function pickPayload(bundled: Payload | null, downloaded: Payload | null): Payload | null {
  if (!bundled) return downloaded
  if (!downloaded) return bundled
  return isNewer(downloaded, bundled) ? downloaded : bundled
}
