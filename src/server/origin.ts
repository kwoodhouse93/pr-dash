const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase())
}

type Headers = { host?: string; origin?: string; secFetchSite?: string }

/**
 * Why an API request is refused, or null when it may proceed. A page on
 * another site must not reach the API: the server acts with the user's GitHub
 * token. `loopbackOnly` also refuses a Host that is not this machine, which is
 * how a DNS rebinding page would arrive.
 */
export function refusal(headers: Headers, loopbackOnly: boolean): string | null {
  const host = parseHost(headers.host)
  if (!host) return 'The request has no valid Host header.'
  if (loopbackOnly && !isLoopback(host.hostname)) return 'This server only answers on its local address.'

  // Browsers send Origin on every cross-site write, and Sec-Fetch-Site on every
  // request. Clients that send neither, such as curl, are not browsers.
  if (headers.origin !== undefined) {
    const origin = parseOrigin(headers.origin)
    if (!origin || origin.host !== host.host) return 'Requests from another site are not allowed.'
  }
  const site = headers.secFetchSite
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Requests from another site are not allowed.'
  return null
}

function parseHost(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(`http://${value}`)
    return url.host === value.toLowerCase() || `${url.hostname}:80` === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}
