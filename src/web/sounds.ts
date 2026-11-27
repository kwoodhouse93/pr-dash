import { load, press, release, setPath } from 'button-sounds'

export type Sound = 'halo-space' | 'halo-shift' | 'halo-soft' | 'halo-hard' | 'tonal-on' | 'tonal-off'

/** The sounds in use. The build copies only these audio files, so a new one here is served without further setup. */
export const SOUNDS: Sound[] = ['halo-space', 'halo-shift', 'halo-soft', 'halo-hard', 'tonal-on', 'tonal-off']

/**
 * Which sound a control makes, first match first. A control can name its own with data-sound,
 * and data-sound="off" keeps it quiet. Anything matching no rule is silent.
 */
const RULES: [selector: string, sound: Sound][] = [
  // Actions that commit to something: merge, fix or resolve with an agent, send a reply, full sync, retry.
  ['.primary', 'halo-space'],
  // Moving between views: the page tabs, the queue, settings and shortcuts, and what a drawer shows.
  ['.refresh-tool', 'halo-hard'],
  ['.tab, .tally, .tool-btn, .feedback-filters button, .feedback-hit, .agent-all, .pop-back', 'halo-shift'],
  // Switching something on or off, choosing from a list, and opening or closing a section.
  [
    '.chip, .chip-x, .sort, .segmented button, .mark-swatch, .mark-icon, .option, [role="menuitemradio"], ' +
      '.thread-toggle, .queue-row-main, .queue-log-toggle, .agent-row',
    'halo-soft',
  ],
  // Everything else that does something: mark ready, resolve a thread, rebase, rerun checks, cancel, copy.
  ['.ghost, .danger, .menu-item, .queue-ic, .num-copy, .icon-btn', 'halo-hard'],
  // Whatever else opens a popup or a panel. A section's own toggle is sounded by fold.
  ['[aria-expanded]:not(.section-toggle)', 'halo-soft'],
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
      if (closes(event.target)) return dismiss()
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
      if (closes(event.target)) return dismiss()
      const sound = soundFor(event.target)
      if (sound) play(press, sound)
    },
    true,
  )
}

function play(trigger: typeof press, sound: Sound) {
  trigger(sound, { volume: VOLUME, playbackRate: 0.97 + Math.random() * 0.06 })
}

/**
 * A stack or a section opening or closing. A click anywhere on its row does it, and so does a shortcut,
 * so this is played by what handles the change. Opening is pitched up and closing down.
 */
export function fold(opening: boolean) {
  if (enabled) press('halo-soft', { volume: VOLUME, playbackRate: opening ? 1.12 : 0.9 })
}

/** Whether what was pressed is the cross that closes a popup, a drawer or a dialog. */
function closes(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button.popover-close:not(:disabled)'))
}

/**
 * A popup, a drawer or a dialog closed without anything being done in it: by its cross, by Escape or by a
 * click outside. It is the sound of one opening, pitched down. Closing because an action ran is silent.
 */
export function dismiss() {
  if (enabled) press('halo-soft', { volume: VOLUME, playbackRate: 0.9 })
}

export type Chime = 'landed' | 'success' | 'warning' | 'error'

/** What a notice plays as it appears: each note is a sound, how fast it is played, and when in milliseconds. */
const CHIMES: Record<Chime, [sound: Sound, rate: number, at: number][]> = {
  // A rising major chord, for a merge that landed.
  landed: [
    ['tonal-on', 1, 0],
    ['tonal-on', 1.26, 90],
    ['tonal-on', 1.5, 180],
    ['tonal-on', 2, 290],
  ],
  success: [['tonal-on', 1.26, 0]],
  warning: [['tonal-off', 1, 0]],
  // Two falling notes.
  error: [
    ['tonal-off', 1, 0],
    ['tonal-off', 0.75, 130],
  ],
}

/** Plays the sound for a notice. Nobody pressed anything, so this is the only sound that plays unprompted. */
export function chime(kind: Chime) {
  if (!enabled) return
  for (const [sound, playbackRate, at] of CHIMES[kind]) {
    // One recording throughout, so the notes differ only by the pitch asked for.
    window.setTimeout(() => press(sound, { volume: VOLUME, playbackRate, sampleIndex: 0 }), at)
  }
}

let audio: AudioContext | null = null

/**
 * The rush of a task flying to the agents, for as long as the flight takes. There is no recording of one,
 * so it is made here: noise through a filter that sweeps up and back, swelling and dying away.
 */
export function whoosh(ms: number) {
  if (!enabled || typeof window.AudioContext !== 'function') return
  try {
    audio ??= new window.AudioContext()
    const length = ms / 1000
    const start = audio.currentTime
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * length), audio.sampleRate)
    const noise = buffer.getChannelData(0)
    for (let index = 0; index < noise.length; index++) noise[index] = Math.random() * 2 - 1
    const source = audio.createBufferSource()
    source.buffer = buffer
    const filter = audio.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 1.1
    filter.frequency.setValueAtTime(350, start)
    filter.frequency.exponentialRampToValueAtTime(2400, start + length * 0.55)
    filter.frequency.exponentialRampToValueAtTime(900, start + length)
    const gain = audio.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(VOLUME * 0.5, start + length * 0.5)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
    source.connect(filter).connect(gain).connect(audio.destination)
    source.start(start)
    source.stop(start + length)
  } catch {
    // A page that may not make sound stays quiet.
  }
}

/** The note of a task landing where its agent is listed. */
export function landed() {
  if (enabled) press('tonal-on', { volume: VOLUME, playbackRate: 1.26, sampleIndex: 0 })
}
