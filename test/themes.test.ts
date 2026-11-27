import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEMES, themeOf } from '../src/shared/themes.ts'
import { PREFERENCES_KEY } from '../src/web/prefs.ts'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const themesCss = read('../src/web/themes.css')

/** The declarations a theme sets: the defaults, with the theme's own block on top. */
function inputs(id: string): Record<string, string> {
  const block = (selector: string) => {
    const start = themesCss.indexOf(`${selector} {`)
    if (start < 0) return ''
    return themesCss.slice(start, themesCss.indexOf('\n}', start))
  }
  const found: Record<string, string> = {}
  for (const text of [block(':root, [data-theme]'), block(`[data-theme="${id}"]`)]) {
    for (const [, name, value] of text.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm)) found[name!] = value!
  }
  return found
}

/** An OKLCH colour as the hex a browser paints for it. */
function hex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const [x, y, z] = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map(
    (v) => v ** 3,
  ) as [number, number, number]
  const linear = [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ]
  return `#${linear
    .map((v) => Math.min(1, Math.max(0, v)))
    .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

describe('colour themes', () => {
  it('lists every theme the stylesheet defines, and no others', () => {
    const styled = [...themesCss.matchAll(/^\[data-theme="([\w-]+)"\]/gm)].map((match) => match[1])
    // The default has no block of its own: its colours are the ones every theme starts from.
    expect([DEFAULT_THEME, ...styled].sort()).toEqual(THEMES.map((theme) => theme.id).sort())
  })

  it('knows which themes are light', () => {
    for (const theme of THEMES) expect(inputs(theme.id)['color-scheme'], theme.id).toBe(theme.scheme)
  })

  it('gives the desktop window the page colour the stylesheet works out', () => {
    for (const theme of THEMES) {
      const set = inputs(theme.id)
      const page = hex(Number(set['--l-bg']), Number(set['--tint-c']) * 0.4, Number(set['--tint-h']))
      expect(theme.bg, theme.id).toBe(page)
    }
    expect(inputs(DEFAULT_THEME)['--bg']).toBe('oklch(var(--l-bg) calc(var(--tint-c) * 0.4) var(--tint-h))')
  })

  it('falls back to the default for a name it does not know', () => {
    expect(themeOf('paper').id).toBe('paper')
    expect(themeOf('neon').id).toBe(DEFAULT_THEME)
    expect(themeOf(undefined).id).toBe(DEFAULT_THEME)
  })

  it('keeps colours out of the other stylesheets', () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i
    for (const file of ['../src/web/styles.css', '../desktop/src/chrome/chrome.css']) {
      const lines = read(file).split('\n')
      const found = lines.flatMap((line, index) => (literal.test(line) ? [`${index + 1}: ${line.trim()}`] : []))
      expect(found, file).toEqual([])
    }
  })

  it('reads the theme in index.html from where the preferences are kept', () => {
    expect(read('../src/web/index.html')).toContain(`localStorage.getItem('${PREFERENCES_KEY}')`)
  })
})
