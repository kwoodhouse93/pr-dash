/**
 * A task leaving for where it will be listed: what was pressed folds into a parcel and flies to a button in
 * the top bar, with a rush on the way and a note as it lands. Settings can turn these off.
 */

import { flyParcel, markCaught, shownBox, type Box } from './flight.ts'
import { landed, whoosh } from './sounds.ts'

/** The button in the top bar that counts agents. */
export const AGENTS_BUTTON = '.agents-tool'
/** The button in the top bar that counts the merge queue. */
export const QUEUE_BUTTON = '.queue-tool'

let enabled = true

export function setSendOffsEnabled(on: boolean) {
  enabled = on
}

export function sendOffsEnabled(): boolean {
  return enabled
}

// Where the last press landed. A send-off always follows a press, and what was pressed may be gone by the
// time there is something to send, as a menu's line is, so its place is noted as it is pressed.
let pressed: Box | null = null
function notePress(target: EventTarget | null) {
  const element = target instanceof Element ? (target.closest('button, a, [role="menuitem"], textarea') ?? target) : null
  pressed = shownBox(element)
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (event) => notePress(event.target), true)
  window.addEventListener('keydown', (event) => notePress(document.activeElement ?? event.target), true)
}

/** Where the last press landed. Null with send-offs turned off, so nothing has a place to leave from. */
export function pressBox(): Box | null {
  return enabled ? pressed : null
}

/**
 * Flies a parcel from `from` to the button `selector` names, and marks the button as it lands. With `ready`,
 * the parcel waits tied up until it is known whether the task was taken, and fades where it is if not.
 */
export async function sendOff(selector: string, from: Box | null, label: string, ready?: Promise<boolean>): Promise<void> {
  if (!enabled || !from) return
  const button = () => document.querySelector(selector)
  if (!(await flyParcel({ layer: document.body, from, label, to: () => shownBox(button()), ready, onTakeoff: whoosh }))) return
  landed()
  markCaught(button())
}
