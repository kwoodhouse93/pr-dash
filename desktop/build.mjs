import { cpSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })
await build({
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
})
cpSync('src/chrome', 'dist/chrome', { recursive: true })
// The strip plays the same flight of a task to the agents as the dashboard does, from the same file.
await build({
  entryPoints: ['../src/web/flight.ts'],
  outfile: 'dist/chrome/flight.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'flight',
  target: 'chrome130',
})
// The window wears the dashboard's colours, so it is built with the dashboard's themes.
cpSync('../src/web/themes.css', 'dist/chrome/themes.css')
