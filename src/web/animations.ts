/** Whether the page animates: as the system asks, or always, or never. Settings chooses. */
export type Animations = 'system' | 'on' | 'off'

export function animationsOf(value: unknown): Animations {
  return value === 'on' || value === 'off' ? value : 'system'
}

/** Puts the choice on the page, where the stylesheets and `reducedMotion` read it. */
export function applyAnimations(choice: Animations) {
  document.documentElement.dataset.animations = choice
}

/**
 * True when nothing should move: animations are turned off in Settings, or they are left to the system and
 * the user has asked it for less motion, or there is no way to ask.
 */
export function reducedMotion(): boolean {
  const choice = document.documentElement.dataset.animations
  if (choice === 'off') return true
  if (choice === 'on') return false
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
