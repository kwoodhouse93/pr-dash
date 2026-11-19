import { execFileSync } from 'node:child_process'

// An app opened from Finder gets a bare PATH, so `gh` and `git` from Homebrew
// are missing. Ask the login shell for the one a terminal would have.
export function adoptShellPath() {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const found = /__PATH__(.*?)__PATH__/s.exec(out)?.[1]
    if (found) process.env.PATH = found
  } catch {
    // Keep the PATH we were given.
  }
}

export function githubToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}
