// The note laid over T3 Code's hand-off page, which is what a thread's link shows until
// this app is paired with T3 Code. It tells the user that pairing shows the thread here.
// The page is T3 Code's own, so the note is put into it from outside, and its buttons
// are links to made-up addresses that the tab catches instead of following.

const ACTION = 'pr-dash-t3:'

export type T3PromptAction = 'pair' | 'settings' | 'never'

/** T3 Code's page that hands a thread off to its app. */
export function isT3Handoff(url: string): boolean {
  return /^https:\/\/app\.t3\.codes\/threads\//.test(url)
}

/** What a button on the note asks for, from the address it links to. Null for any other address. */
export function t3PromptAction(url: string): T3PromptAction | null {
  if (!url.startsWith(ACTION)) return null
  const action = url.slice(ACTION.length)
  return action === 'pair' || action === 'settings' || action === 'never' ? action : null
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

/** Puts the note on the page. Running it again leaves the one already there. */
export const T3_PROMPT_SCRIPT = `(() => {
  if (document.getElementById('pr-dash-t3-prompt')) return
  const make = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }
  const link = (action, className, text) => {
    const node = make('a', className, text)
    node.href = ${JSON.stringify(ACTION)} + action
    return node
  }
  const card = make('div')
  card.id = 'pr-dash-t3-prompt'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Show T3 Code threads in PR Dash')
  const close = make('button', 'pdt-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => card.remove()
  const actions = make('div', 'pdt-actions')
  actions.append(link('pair', 'pdt-primary', 'Pair'), link('settings', '', 'View settings'), link('never', 'pdt-never', 'Don’t ask again'))
  card.append(
    close,
    make('p', 'pdt-title', 'Read this thread here instead'),
    make('p', 'pdt-text', 'Pair PR Dash with T3 Code and a thread opens in this tab, where you can read it and reply. Pairing lets PR Dash read threads and take part in them, nothing wider.'),
    make('p', 'pdt-error'),
    actions,
  )
  // On the root, so the page redrawing its body does not take the note with it.
  document.documentElement.append(card)
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
