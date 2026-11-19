// Builds what the desktop app runs and updates: the bundled server, the built
// web assets, and a version stamp. The server reads dist/web and .env from its
// working directory, so the layout here mirrors the repository's.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist', 'payload')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src/server/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})

cpSync(path.join(root, 'dist', 'web'), path.join(out, 'dist', 'web'), { recursive: true })

const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
writeFileSync(path.join(out, 'version.json'), JSON.stringify({ sha, builtAt: new Date().toISOString() }) + '\n')

execFileSync('tar', ['-czf', path.join(root, 'dist', 'payload.tar.gz'), '-C', out, '.'])
console.log(`payload ${sha.slice(0, 7)} → dist/payload.tar.gz`)
