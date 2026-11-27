/**
 * A request turned down for a reason the user can act on. The message is shown as it is,
 * the status says what kind of refusal it was, and a code lets the page tell one apart without reading the words.
 */
export class Refused extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503
  readonly code: string | null

  constructor(message: string, status: Refused['status'] = 400, code: string | null = null) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
  }

  /** What rides along with the message in the response. */
  get detail(): Record<string, unknown> {
    return {}
  }
}

export const PULL_GONE = 'That pull request is no longer in this list.'

export const COMMENT_GONE = 'That comment is no longer on the pull request.'

export function pullGone(): Refused {
  return new Refused(PULL_GONE, 404)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed'
}

/** The response for anything a route threw. What was not a refusal came from GitHub, Linear or git. */
export function failure(error: unknown): { status: Refused['status'] | 502; body: Record<string, unknown> } {
  if (!(error instanceof Refused)) return { status: 502, body: { error: messageOf(error) } }
  return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}), ...error.detail } }
}
