import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isNewer, readPayload, type Payload } from './payload.ts'
import { githubToken } from './shell-env.ts'

const run = promisify(execFile)

const REPO = 'kwoodhouse93/pr-dash'
const TAG = 'payload'
const ASSET = 'payload.tar.gz'

// seenAssetId is the newest release asset already looked at, whether it was
// installed, older than what is running, or rolled back after it failed.
type State = { seenAssetId?: number; current?: string }

export class Updater {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  private get stateFile() {
    return path.join(this.root, 'state.json')
  }

  private state(): State {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as State
    } catch {
      return {}
    }
  }

  private save(state: State) {
    writeFileSync(this.stateFile, JSON.stringify(state))
  }

  downloaded(): Payload | null {
    const name = this.state().current
    return name ? readPayload(path.join(this.root, name)) : null
  }

  // Downloads the published payload when it is newer than the running one.
  async fetchNewer(running: Payload): Promise<Payload | null> {
    const token = githubToken()
    if (!token) throw new Error('No GitHub token, so updates cannot be checked.')
    const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }

    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
      headers: { ...headers, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the payload release.`)
    const release = (await res.json()) as { assets?: { id: number; name: string; digest?: string | null }[] }
    const asset = release.assets?.find((item) => item.name === ASSET)
    if (!asset || asset.id === this.state().seenAssetId) return null

    const download = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, {
      headers: { ...headers, Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(120_000),
    })
    if (!download.ok) throw new Error(`GitHub answered ${download.status} for the payload download.`)
    const bytes = Buffer.from(await download.arrayBuffer())
    if (asset.digest?.startsWith('sha256:')) {
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== asset.digest.slice('sha256:'.length)) throw new Error('The payload download does not match its checksum.')
    }

    const staging = path.join(this.root, `staging-${asset.id}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging)
    const archive = path.join(staging, ASSET)
    writeFileSync(archive, bytes)
    await run('/usr/bin/tar', ['-xzf', archive, '-C', staging])
    rmSync(archive)

    const payload = readPayload(staging)
    if (!payload || !isNewer(payload, running)) {
      rmSync(staging, { recursive: true, force: true })
      this.save({ ...this.state(), seenAssetId: asset.id })
      return null
    }
    const name = `${payload.sha.slice(0, 12)}-${asset.id}`
    const dir = path.join(this.root, name)
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    this.save({ seenAssetId: asset.id, current: name })
    return { ...payload, dir }
  }

  // Called after an update failed to start: go back to what ran before and
  // leave that release asset alone until a newer one is published.
  reject(previous: Payload) {
    const inRoot = path.dirname(previous.dir) === this.root
    this.save({ seenAssetId: this.state().seenAssetId, current: inRoot ? path.basename(previous.dir) : undefined })
  }

  prune(keep: Payload) {
    if (!existsSync(this.root)) return
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.root, entry.name)
      if (dir !== keep.dir) rmSync(dir, { recursive: true, force: true })
    }
  }
}
