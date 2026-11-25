import { load, press, release, setPath } from 'button-sounds'

export type Sound = 'halo-space' | 'halo-shift' | 'halo-soft' | 'halo-hard'

/** The sounds in use. The build copies only these audio files, so a new one here is served without further setup. */
export const SOUNDS: Sound[] = ['halo-space', 'halo-shift', 'halo-soft', 'halo-hard']

/**
 * Which sound a control makes, first match first. A control can name its own with data-sound,
 * and data-sound="off" keeps it quiet. Anything matching no rule is silent.
 */
const RULES: [selector: string, sound: Sound][] = [
  // Actions that commit to something: merge, fix or resolve with an agent, send a reply, full sync, retry.
  ['.primary', 'halo-space'],
  // Moving between views: the page tabs, the queue, settings and shortcuts, and what a drawer shows.
  ['.refresh-tool', 'halo-hard'],
  ['.tab, .tool-btn, .feedback-filters button, .feedback-hit, .agent-all', 'halo-shift'],
  // Switching something on or off, choosing from a list, and opening or closing a section.
  [
    '.chip, .chip-x, .sort, .segmented button, .mark-swatch, .mark-icon, .option, [role="menuitemradio"], ' +
      '.section-toggle, .thread-toggle, .queue-row-main, .queue-log-toggle, .agent-row',
    'halo-soft',
  ],
  // Everything else that does something: mark ready, resolve a thread, rebase, rerun checks, cancel, copy.
  ['.ghost, .danger, .menu-item, .queue-ic, .num-copy, .icon-btn', 'halo-hard'],
]

const VOLUME = 0.35

let enabled = false

export function soundFor(target: EventTarget | null): Sound | null {
  if (!(target instanceof Element)) return null
  const control = target.closest('button, [data-sound]')
  if (!control || control.matches(':disabled, [aria-disabled="true"]')) return null
  const named = control.getAttribute('data-sound')
  if (named === 'off') return null
  if (named && (SOUNDS as string[]).includes(named)) return named as Sound
  return RULES.find(([selector]) => control.matches(selector))?.[1] ?? null
}

/** Turns the sounds on or off. The audio is fetched the first time they are turned on. */
export function setSoundsEnabled(on: boolean) {
  enabled = on
  if (on) for (const sound of SOUNDS) load(sound)
}

/** Listens once for the whole page, so a button needs no wiring of its own. */
export function installSounds() {
  setPath('/assets/sounds')
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!enabled || event.button !== 0) return
      const sound = soundFor(event.target)
      if (!sound) return
      play(press, sound)
      // The key comes back up wherever the pointer is let go, and only after it went down on a button.
      window.addEventListener('pointerup', () => play(release, sound), { once: true })
    },
    true,
  )
  // A click with no pointer behind it came from the keyboard.
  document.addEventListener(
    'click',
    (event) => {
      if (!enabled || event.detail !== 0) return
      const sound = soundFor(event.target)
      if (sound) play(press, sound)
    },
    true,
  )
}

function play(trigger: typeof press, sound: Sound) {
  trigger(sound, { volume: VOLUME, playbackRate: 0.97 + Math.random() * 0.06 })
}
