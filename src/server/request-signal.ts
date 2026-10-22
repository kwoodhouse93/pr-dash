import { AsyncLocalStorage } from 'node:async_hooks'

const signals = new AsyncLocalStorage<AbortSignal>()

/** GitHub, Linear, and Cursor calls made inside `run` abort when `signal` aborts. */
export function withRequestSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return signals.run(signal, run)
}

export function requestSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  const parent = signals.getStore()
  if (!parent) return timeout
  return AbortSignal.any([timeout, parent])
}
