import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** T3 Code's data folder on this machine. */
export const T3_HOME = () => process.env.T3CODE_HOME || path.join(homedir(), '.t3')

/** The address the T3 Code on this machine answers at, from what it writes down when it starts. Null when it has not. */
export function t3Origin(home = T3_HOME()): string | null {
  try {
    const { origin } = JSON.parse(readFileSync(path.join(home, 'userdata', 'server-runtime.json'), 'utf8')) as { origin?: unknown }
    if (typeof origin !== 'string') return null
    const url = new URL(origin)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}
