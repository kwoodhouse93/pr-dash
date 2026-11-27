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
 * How a sign-in ended, from the address T3 Code sent the tab to and how the dashboard's server answered it.
 * `done` covers approved and turned down alike: both go back to Settings. `failed` is a sign-in that was
 * approved and still did not take, which that page explains. Null for any other address.
 */
export function connectOutcome(url: string, status: number, dashboardUrl: string): 'done' | 'failed' | null {
  // T3 Code's page emptied the tab instead of sending it anywhere.
  if (url === 'about:blank') return 'done'
  try {
    const landed = new URL(url)
    if (landed.origin !== new URL(dashboardUrl).origin || landed.pathname !== T3_CONNECTED_PATH) return null
    return status === 200 || landed.searchParams.has('error') ? 'done' : 'failed'
  } catch {
    return null
  }
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
  actions: { action: T3PromptAction | T3ConnectAction; text: string; className?: string }[]
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
    const link = make('a', button.className, button.text)
    link.href = ${JSON.stringify(ACTION)} + button.action
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

export const T3_CONNECT_SCRIPT = noteScript({
  label: 'Pairing code for T3 Code',
  title: 'If T3 Code asks for a pairing code, paste it',
  text: 'PR Dash has put one on your clipboard, so ⌘V in the box is all it needs. The code works once, and for five minutes. Then approve PR Dash, or deny it, and you are taken back to Settings.',
  actions: [{ action: 'copy', text: 'Copy the code again' }],
  closed: 'dismiss',
})

/** Says on the sign-in note that the code is on the clipboard again. */
export const T3_CONNECT_COPIED = `(() => {
  const link = document.querySelector('#pr-dash-t3-prompt .pdt-actions a')
  if (link) link.textContent = 'Copied'
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
