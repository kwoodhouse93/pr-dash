import type { PressBox } from './agents.ts'

// What the desktop app's window tells the dashboard page. The window runs a line of script in the page,
// which raises an event there. Both sides take the event's name and what it carries from here.

/** The pages the window's sidebar links to. `list` is whichever of the two lists was last open. */
export type DesktopPage = 'list' | 'agents' | 'queue' | 'settings'

export const DESKTOP_PAGES: readonly DesktopPage[] = ['list', 'agents', 'queue', 'settings']

export type DesktopEvents = {
  /** Show this page. */
  'pr-dash:page': DesktopPage
  /** Pairing with T3 Code moved on in a tab: it paired with `origin`, it failed, or the user asked not to be offered it again. */
  'pr-dash:t3': { origin?: string; prompt?: false; failed?: true }
  /**
   * The sign-in to T3 Code that Settings started has ended in a tab, approved or not, so Settings should look again.
   * `unanswered` is an approval the dashboard's server never took, which leaves PR Dash signed out with nothing to show why.
   */
  'pr-dash:t3-connect': { ended: true; unanswered: boolean }
  /** Where a task that was just started lands in the window, in the page's own units, and when the flight to it begins. */
  'pr-dash:flight': { to: PressBox | null; at: number }
}

/** The script the window runs in the page to raise one of these events. */
export function raiseInPage<Name extends keyof DesktopEvents>(name: Name, detail: DesktopEvents[Name]): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, { detail: ${JSON.stringify(detail)} }))`
}

/**
 * Listens for one of these events in the page, and returns what stops listening. What arrives came from
 * outside the page, so every field is unknown until the listener has checked it.
 */
export function onDesktopEvent<Name extends keyof DesktopEvents>(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  name: Name,
  listener: (detail: unknown) => void,
): () => void {
  const heard = (event: Event) => listener((event as CustomEvent<unknown>).detail)
  target.addEventListener(name, heard)
  return () => target.removeEventListener(name, heard)
}
