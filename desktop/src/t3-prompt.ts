// Notes laid over T3 Code's own pages in a tab. One, on the page that hands a thread off to T3 Code's
// app, says that pairing shows the thread here. The other, on the page where the user approves PR Dash's
// sign-in, says the pairing code that page may ask for is ready to paste.
// The pages are T3 Code's, so a note is put into one from outside, and its buttons
// are links to made-up addresses that the tab catches instead of following.

import { T3_CONNECTED_PATH } from '../../src/shared/agents.ts'

const ACTION = 'pr-dash-t3:'

/** What a button on the pairing note asks for. */
export type T3PromptAction = 'pair' | 'settings' | 'never'
/** What a button on the sign-in note asks for. */
export type T3ConnectAction = 'copy' | 'dismiss'

const ACTIONS: readonly (T3PromptAction | T3ConnectAction)[] = ['pair', 'settings', 'never', 'copy', 'dismiss']

/** T3 Code's page that hands a thread off to its app. */
export function isT3Handoff(url: string): boolean {
  return /^https:\/\/app\.t3\.codes\/threads\//.test(url)
}

/** What a button on a note asks for, from the address it links to. Null for any other address. */
export function t3PromptAction(url: string): T3PromptAction | T3ConnectAction | null {
  if (!url.startsWith(ACTION)) return null
  const action = url.slice(ACTION.length)
  return ACTIONS.find((known) => known === action) ?? null
}

export function isConnectAction(action: T3PromptAction | T3ConnectAction): action is T3ConnectAction {
  return action === 'copy' || action === 'dismiss'
}

/** The page of the T3 Code on this machine where the user approves PR Dash's sign-in. */
export function isT3ConnectLink(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url)
    return (hostname === '127.0.0.1' || hostname === 'localhost') && pathname === '/oauth/mcp/authorize'
  } catch {
    return false
  }
}

/**
 * What T3 Code answered a sign-in with, from the address it sends the tab to: the dashboard's own page for
 * the answer, carrying a code when the user approved and an error when they did not. Null for any other address.
 */
export function connectAnswer(url: string, dashboardUrl: string): 'approved' | 'denied' | null {
  try {
    const sent = new URL(url)
    if (sent.origin !== new URL(dashboardUrl).origin || sent.pathname !== T3_CONNECTED_PATH) return null
    return sent.searchParams.has('error') ? 'denied' : 'approved'
  } catch {
    return null
  }
}

/**
 * How a sign-in ended, from the page its tab reached and how the dashboard's server answered. `done` goes
 * back to Settings. `failed` is a sign-in that was approved and still did not take, which that page explains.
 * Null while the tab is anywhere else.
 */
export function connectOutcome(url: string, status: number, dashboardUrl: string): 'done' | 'failed' | null {
  // T3 Code's page emptied the tab instead of sending it anywhere.
  if (url === 'about:blank') return 'done'
  const answer = connectAnswer(url, dashboardUrl)
  if (!answer) return null
  return answer === 'denied' || status === 200 ? 'done' : 'failed'
}

/** A link that pairs whichever browser opens it with the T3 Code on this machine. */
export function isT3PairLink(url: string): boolean {
  try {
    const { hostname, pathname, hash } = new URL(url)
    return (hostname === '127.0.0.1' || hostname === 'localhost') && pathname === '/pair' && hash.startsWith('#token=')
  } catch {
    return false
  }
}

export const T3_PROMPT_CSS = `
#pr-dash-t3-prompt {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  box-sizing: border-box; width: min(520px, calc(100vw - 32px)); padding: 16px 18px;
  border: 1px solid #3a3b33; border-radius: 12px; background: #1b1c18; color: #f3f0e7;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  font: 14px/1.45 "Source Sans 3", -apple-system, "Segoe UI", sans-serif; text-align: left;
}
#pr-dash-t3-prompt * { box-sizing: border-box; font: inherit; }
#pr-dash-t3-prompt .pdt-title { margin: 0 24px 4px 0; font-weight: 600; font-size: 15px; }
#pr-dash-t3-prompt .pdt-text { margin: 0; color: #b9b5a8; }
#pr-dash-t3-prompt .pdt-error { margin: 8px 0 0; color: #e36a58; }
#pr-dash-t3-prompt .pdt-error:empty { display: none; }
#pr-dash-t3-prompt .pdt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 14px; }
#pr-dash-t3-prompt a { color: #b9b5a8; text-decoration: none; cursor: pointer; }
#pr-dash-t3-prompt a:hover { color: #f3f0e7; }
#pr-dash-t3-prompt a.pdt-primary { padding: 6px 14px; border-radius: 8px; background: #e0a15a; color: #10110f; font-weight: 600; }
#pr-dash-t3-prompt a.pdt-primary:hover { background: #ecb373; color: #10110f; }
#pr-dash-t3-prompt[data-busy] a { pointer-events: none; opacity: 0.6; }
#pr-dash-t3-prompt .pdt-never { margin-left: auto; }
#pr-dash-t3-prompt a.pdt-copy {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px;
  border: 1px solid #55564c; border-radius: 8px; background: #262720; color: #f3f0e7;
}
#pr-dash-t3-prompt a.pdt-copy:hover { border-color: #8d8a7f; background: #2f3028; }
#pr-dash-t3-prompt a.pdt-copy code { font: 13px "Source Code Pro", ui-monospace, monospace; color: #e0a15a; }
#pr-dash-t3-prompt a.pdt-copy svg { width: 15px; height: 15px; flex: none; color: #b9b5a8; }
#pr-dash-t3-prompt a.pdt-copy:hover svg { color: #f3f0e7; }
#pr-dash-t3-prompt .pdt-close {
  position: absolute; top: 10px; right: 12px; padding: 2px 6px; border: 0; background: none;
  color: #8d8a7f; font-size: 16px; line-height: 1; cursor: pointer;
}
#pr-dash-t3-prompt .pdt-close:hover { color: #f3f0e7; }
`

type Note = {
  /** What the note is, for a screen reader. */
  label: string
  title: string
  text: string
  actions: {
    action: T3PromptAction | T3ConnectAction
    text: string
    className?: string
    /** Shown after the text, in the type a code is written in, with a clipboard beside it. */
    code?: string
  }[]
  /** Asked for when the note is closed, for a note that should stay closed on the next page. */
  closed?: T3ConnectAction
}

/** The script that puts a note on the page. Running it again leaves the one already there. */
function noteScript(note: Note): string {
  return `(() => {
  if (document.getElementById('pr-dash-t3-prompt')) return
  const note = ${JSON.stringify(note)}
  const make = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }
  const card = make('div')
  card.id = 'pr-dash-t3-prompt'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', note.label)
  const close = make('button', 'pdt-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => {
    card.remove()
    if (note.closed) location.href = ${JSON.stringify(ACTION)} + note.closed
  }
  const actions = make('div', 'pdt-actions')
  for (const button of note.actions) {
    const link = make('a', button.className, button.code ? '' : button.text)
    link.href = ${JSON.stringify(ACTION)} + button.action
    if (button.code) {
      // Drawn node by node: T3 Code's page may not let markup in as text.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      for (const [name, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(name, value)
      const top = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      for (const [name, value] of [['x', '8'], ['y', '2'], ['width', '8'], ['height', '4'], ['rx', '1']]) top.setAttribute(name, value)
      const board = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      board.setAttribute('d', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2')
      svg.append(top, board)
      link.append(make('span', 'pdt-label', button.text), make('code', '', button.code), svg)
    }
    actions.append(link)
  }
  card.append(close, make('p', 'pdt-title', note.title), make('p', 'pdt-text', note.text), make('p', 'pdt-error'), actions)
  // On the root, so the page redrawing its body does not take the note with it.
  document.documentElement.append(card)
})()`
}

export const T3_PROMPT_SCRIPT = noteScript({
  label: 'Show T3 Code threads in PR Dash',
  title: 'Read this thread here instead',
  text: 'Pair PR Dash with T3 Code and a thread opens in this tab, where you can read it and reply. Pairing lets PR Dash read threads and take part in them, nothing wider.',
  actions: [
    { action: 'pair', text: 'Pair', className: 'pdt-primary' },
    { action: 'settings', text: 'View settings' },
    { action: 'never', text: 'Don’t ask again', className: 'pdt-never' },
  ],
})

const COPY_AGAIN = 'Copy again:'

/** The note on the page where PR Dash's sign-in is approved. `code` is the pairing code already on the clipboard. */
export function t3ConnectScript(code: string): string {
  return noteScript({
    label: 'Sign-in code for T3 Code',
    title: 'Sign-in code copied to clipboard',
    text: 'Paste and Approve to connect PR Dash',
    actions: [{ action: 'copy', text: COPY_AGAIN, className: 'pdt-copy', code }],
    closed: 'dismiss',
  })
}

/** Says on the sign-in note, for a moment, that the code is on the clipboard again. */
export const T3_CONNECT_COPIED = `(() => {
  const label = document.querySelector('#pr-dash-t3-prompt .pdt-copy .pdt-label')
  if (!label) return
  label.textContent = 'Copied:'
  setTimeout(() => { label.textContent = ${JSON.stringify(COPY_AGAIN)} }, 1500)
})()`

/** Marks the note busy while pairing, shows why pairing failed, or takes the note away. */
export function t3PromptUpdate(change: { busy: boolean; error?: string } | 'remove'): string {
  if (change === 'remove') return `document.getElementById('pr-dash-t3-prompt')?.remove()`
  return `(() => {
  const card = document.getElementById('pr-dash-t3-prompt')
  if (!card) return
  card.toggleAttribute('data-busy', ${JSON.stringify(change.busy)})
  card.querySelector('.pdt-primary').textContent = ${JSON.stringify(change.busy ? 'Pairing…' : 'Pair')}
  card.querySelector('.pdt-error').textContent = ${JSON.stringify(change.error ?? '')}
})()`
}
