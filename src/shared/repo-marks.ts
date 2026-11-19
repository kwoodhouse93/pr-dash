import type { RepoMark } from './types.ts'

/** Outline icons on a 16 by 16 grid, drawn with a 1.4 stroke and no fill. */
export const REPO_ICONS: Record<string, string> = {
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  terminal: 'M3 4.5 6.5 8 3 11.5M8.5 11.5H13',
  box: 'M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8ZM2.5 4.8 8 7.8l5.5-3M8 7.8v6.4',
  layers: 'M8 2 14 5 8 8 2 5ZM2 8l6 3 6-3M2 11l6 3 6-3',
  database:
    'M2.8 4c0-1.2 2.3-2.2 5.2-2.2s5.2 1 5.2 2.2-2.3 2.2-5.2 2.2S2.8 5.2 2.8 4ZM2.8 4v8c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4M2.8 8c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM2 8h12M8 2C6 3.8 5.4 5.8 5.4 8S6 12.2 8 14c2-1.8 2.6-3.8 2.6-6S10 3.8 8 2Z',
  bolt: 'M9 1.8 3.5 9H8l-1 5.2L12.5 7H8Z',
  shield: 'M8 1.8 13 3.6v4.2c0 3-2 5.2-5 6.4-3-1.2-5-3.4-5-6.4V3.6Z',
  flask: 'M6 2h4M6.5 2v4L2.8 12.5c-.4.8.1 1.7 1 1.7h8.4c.9 0 1.4-.9 1-1.7L9.5 6V2M4.6 10h6.8',
  star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z',
  heart: 'M8 13.5 2.9 8.6a3.1 3.1 0 0 1 4.4-4.4l.7.7.7-.7a3.1 3.1 0 0 1 4.4 4.4Z',
  flag: 'M3.5 14V2.5M3.5 3H12l-2 3 2 3H3.5',
  cloud: 'M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.9 7.5a2.5 2.5 0 0 1-.4 5Z',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5Z',
  sun: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1',
  mountain: 'M1.8 13 6 5.5l2.5 4L10 7.2l4.2 5.8Z',
  wave: 'M1.8 6c1.5-1.5 2.6-1.5 4.1 0s2.6 1.5 4.1 0 2.6-1.5 4.2 0M1.8 10.5c1.5-1.5 2.6-1.5 4.1 0s2.6 1.5 4.1 0 2.6-1.5 4.2 0',
  hexagon: 'M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z',
  diamond: 'M8 1.8 14.2 8 8 14.2 1.8 8Z',
  triangle: 'M8 2.5 14 13H2Z',
  circle: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z',
  square: 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
}

/** Muted on purpose: the repository is rarely the most important thing on a row. */
export const REPO_COLORS = [
  '#c9a06e',
  '#cdb065',
  '#8fb07c',
  '#7fbdb6',
  '#7fa6c4',
  '#9aa3d6',
  '#b79bd0',
  '#c79bb8',
  '#c98b95',
  '#cf8f7a',
  '#9c968a',
]

function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** The same repository always gets the same pair, so it looks picked at random but does not change between loads. */
export function defaultRepoMark(repo: string): RepoMark {
  const icons = Object.keys(REPO_ICONS)
  const seed = hash(repo.toLowerCase())
  return {
    icon: icons[seed % icons.length]!,
    color: REPO_COLORS[Math.floor(seed / icons.length) % REPO_COLORS.length]!,
  }
}

export function validRepoMark(mark: { icon?: unknown; color?: unknown }): mark is RepoMark {
  return typeof mark.icon === 'string' && Object.hasOwn(REPO_ICONS, mark.icon) && typeof mark.color === 'string' && REPO_COLORS.includes(mark.color)
}

export function repoMarkOf(repo: string, saved: Record<string, RepoMark> | undefined): RepoMark {
  const mark = saved?.[repo]
  return mark && validRepoMark(mark) ? mark : defaultRepoMark(repo)
}
