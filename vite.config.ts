import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { SOUNDS } from './src/web/sounds.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Serves the button sounds from the dashboard itself, so they work offline and nothing is fetched from a CDN.
 * Only the sounds in use are copied out of the package, which holds 9 MB of them.
 */
function buttonSounds(): Plugin {
  const file = (name: string) => path.join(projectRoot, 'node_modules/button-sounds/assets', `${name}.mp3`)
  return {
    name: 'button-sounds',
    configureServer(server) {
      server.middlewares.use('/assets/sounds', (req, res, next) => {
        const name = SOUNDS.find((sound) => req.url?.split('?')[0] === `/${sound}.mp3`)
        if (!name) return next()
        res.setHeader('Content-Type', 'audio/mpeg')
        res.end(readFileSync(file(name)))
      })
    },
    generateBundle() {
      for (const name of SOUNDS) this.emitFile({ type: 'asset', fileName: `assets/sounds/${name}.mp3`, source: readFileSync(file(name)) })
    },
  }
}

export default defineConfig({
  plugins: [react(), buttonSounds()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [projectRoot] },
    proxy: {
      '/api/': { target: 'http://127.0.0.1:4317', timeout: 180_000 },
    },
  },
})
