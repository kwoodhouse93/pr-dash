import { themeOf, type Theme, type ThemeId } from '../shared/themes.ts'

/** Puts the page in a theme. themes.css does the rest. */
export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id
}

/** The theme the page is in. */
export function currentTheme(): Theme {
  return themeOf(document.documentElement.dataset.theme)
}

/**
 * A theme colour as the page draws it now, for the few things a stylesheet cannot reach: a canvas, or a page
 * written into another window. Pass the token's name without its dashes.
 */
export function themeColor(token: string): string {
  const probe = document.createElement('i')
  probe.style.color = `var(--${token})`
  document.documentElement.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}
