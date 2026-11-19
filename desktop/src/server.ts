import { createWriteStream, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { Payload } from './payload.ts'

export type ServerOptions = { port: number; databasePath: string; logFile: string }

let child: UtilityProcess | null = null
let log: WriteStream | null = null

export function serverOrigin(options: ServerOptions): string {
  return `http://127.0.0.1:${options.port}`
}

// Resolves once the server answers, and rejects when it exits first or takes
// longer than 20 seconds.
export async function startServer(payload: Payload, options: ServerOptions): Promise<void> {
  // Without this, another process already on the port would answer the
  // readiness check below and pass for ours.
  if (!(await portFree(options.port))) throw new Error(`Port ${options.port} is already in use.`)
  log ??= createWriteStream(options.logFile, { flags: 'w' })
  const started = utilityProcess.fork(path.join(payload.dir, 'server.mjs'), [], {
    cwd: payload.dir,
    env: { ...process.env, PORT: String(options.port), HOST: '127.0.0.1', DATABASE_PATH: options.databasePath },
    stdio: 'pipe',
    serviceName: 'pr-dash server',
  })
  child = started
  log.write(`--- start ${payload.sha.slice(0, 7)} ${new Date().toISOString()}\n`)
  started.stdout?.on('data', (chunk) => log?.write(chunk))
  started.stderr?.on('data', (chunk) => log?.write(chunk))

  let exited = false
  started.once('exit', () => {
    exited = true
    if (child === started) child = null
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (exited) throw new Error('The server stopped while starting.')
    try {
      const res = await fetch(`${serverOrigin(options)}/api/status`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await stopServer()
  throw new Error('The server did not answer within 20 seconds.')
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

export async function stopServer(): Promise<void> {
  const running = child
  if (!running) return
  child = null
  await new Promise<void>((resolve) => {
    const force = setTimeout(resolve, 3000)
    running.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    running.kill()
  })
}
