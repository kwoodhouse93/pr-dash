/**
 * The colour themes, each named as src/web/themes.css names it. The colours themselves are in that file.
 * `bg` repeats a theme's page colour for the desktop window, which paints it before any page has drawn.
 */
export const THEMES = [
  { id: 'ember', label: 'Ember', scheme: 'dark', bg: '#11110f' },
  { id: 'graphite', label: 'Graphite', scheme: 'dark', bg: '#111111' },
  { id: 'ink', label: 'Ink', scheme: 'dark', bg: '#0f1113' },
  { id: 'moss', label: 'Moss', scheme: 'dark', bg: '#0f1110' },
  { id: 'paper', label: 'Paper', scheme: 'light', bg: '#f4f2ef' },
] as const

export type Theme = (typeof THEMES)[number]
export type ThemeId = Theme['id']

export const DEFAULT_THEME: ThemeId = 'ember'

/** The theme saved under this name, or the default when the name is not one of ours. */
export function themeOf(id: unknown): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}
