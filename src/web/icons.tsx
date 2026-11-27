import type { ReactNode } from 'react'

// Every icon the dashboard draws from a fixed shape. To add one, add a line here and use it with <Icon name="…" />.
// An icon is drawn in outline in the colour of the text around it, and its size comes from the stylesheet,
// which sizes the svg inside whatever holds it. A shape that is filled says so with `solid`.
// What is not here is drawn from data: a Linear status, a repository's mark, the age ring and the cobweb.

type Drawing = {
  /** The side of the square the shape is drawn in. 16 unless said. */
  box?: number
  /** The width of its lines. 1.5 unless said. */
  width?: number
  draw: ReactNode
}

function lines(...paths: string[]): ReactNode {
  return paths.map((d) => <path key={d} d={d} />)
}

const solid = { fill: 'currentColor', stroke: 'none' } as const

const ICONS = {
  refresh: { draw: lines('M13.2 8a5.2 5.2 0 1 1-1.6-3.75', 'M13.3 2.6v2.9h-2.9') },
  trash: { draw: lines('M2.8 4.3h10.4', 'M6.3 4.3V2.9h3.4v1.4', 'M4.1 4.3l.6 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.6-8.3', 'M6.7 7v3.8M9.3 7v3.8') },
  x: { draw: lines('M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4') },
  back: { draw: lines('M10 3.5 5.5 8 10 12.5') },
  chevron: { draw: lines('M6 3.5 10.5 8 6 12.5') },
  copy: { draw: lines('M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5A1.5 1.5 0 0 1 12 13.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5Z', 'M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5') },
  chat: { draw: lines('M2.5 3.5h11V11H7l-3 2.5V11H2.5Z') },
  merge: { draw: lines('M4 5.1v5.8', 'M4 5.5c0 2 2.5 2.5 6.4 2.5', 'M5.6 3.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z', 'M5.6 12.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z', 'M13.6 8a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z') },
  spark: { draw: lines('M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8l4.7-1.5Z') },
  alert: { draw: lines('M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z', 'M8 4.8v3.6M8 11v.2') },
  link: { draw: lines('M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8', 'M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.300 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8') },
  tag: { draw: lines('M2 2.5h5.5l6.2 6.2-5 5L2.5 7.5Z', 'M6.2 5.3a.9.9 0 1 1-1.8 0a.9.9 0 0 1 1.8 0Z') },
  // Arrows and marks.
  fold: { width: 1.6, draw: lines('M6 3.5 11 8 6 12.5') },
  caret: { box: 10, draw: lines('M2 3.5 5 6.5 8 3.5') },
  up: { width: 1.7, draw: lines('M8 12.5v-9M4 7l4-4 4 4') },
  down: { width: 1.7, draw: lines('M8 3.5v9M4 9l4 4 4-4') },
  cross: { width: 1.8, draw: lines('M4 4 12 12 M12 4 4 12') },
  tick: { width: 1.6, draw: lines('M3.5 8.5 6.5 11.5 12.5 4.5') },
  search: {
    width: 1.6,
    draw: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </>
    ),
  },
  // The header.
  sync: { box: 24, width: 2, draw: lines('M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16', 'M16 16h5v5') },
  agents: {
    box: 24,
    width: 1.8,
    draw: (
      <>
        <rect x="4" y="9" width="16" height="11" rx="3" />
        <path d="M12 5v4M9 14v1.5M15 14v1.5M2 13.5v3M22 13.5v3" />
        <circle cx="12" cy="3.5" r="1.5" />
      </>
    ),
  },
  queue: {
    box: 24,
    width: 1.8,
    draw: (
      <>
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </>
    ),
  },
  keyboard: {
    box: 24,
    width: 1.8,
    draw: (
      <>
        <rect x="2.5" y="6" width="19" height="12" rx="2" />
        <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7 14h10" />
      </>
    ),
  },
  settings: {
    box: 24,
    width: 1.8,
    draw: (
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
  // A row of the table.
  robot: {
    width: 1.4,
    draw: (
      <>
        <path d="M8 1.6v2.2" />
        <rect x="3" y="3.8" width="10" height="8.4" rx="2.2" />
        <path d="M1.2 7.2v2.2M14.8 7.2v2.2M6.4 14.4h3.2" />
        <path d="M6 7.4v1.4M10 7.4v1.4" />
      </>
    ),
  },
  copyNumber: {
    width: 1.4,
    draw: (
      <>
        <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.4" />
        <path d="M10.75 5.25V3.15A1.15 1.15 0 0 0 9.6 2H3.15A1.15 1.15 0 0 0 2 3.15V9.6c0 .64.51 1.15 1.15 1.15H5.25" strokeLinecap="butt" />
      </>
    ),
  },
  file: {
    width: 1.4,
    draw: lines('M4 1.75h5.15L13.1 5.7V13.2c0 .58-.47 1.05-1.05 1.05H4A1.05 1.05 0 0 1 2.95 13.2V2.8C2.95 2.22 3.42 1.75 4 1.75Z', 'M9.05 1.9v3.85h3.85'),
  },
  github: { draw: <path {...solid} d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /> },
  graphite: { draw: <path {...solid} d="M8 1.2 2.4 4.4v7.2L8 14.8l5.6-3.2V4.4L8 1.2Zm0 1.85 3.85 2.2v.01L8 7.45 4.15 5.26 8 3.05Zm-4.4 3.4 3.85 2.2v4.35L3.6 10.8V6.45Zm5 6.55V8.65l3.85-2.2v4.35L8.6 13Z" /> },
  // The three review marks: any approval, a person's approval, and GitHub's own requirement to merge.
  approved: { width: 1.7, draw: lines('M3.2 8.2 6.4 11.4 12.8 4.6') },
  person: {
    draw: (
      <>
        <circle {...solid} cx="8" cy="5" r="2.15" />
        <path d="M3.5 13.15c.6-2.45 2.2-3.65 4.5-3.65s3.9 1.2 4.5 3.65" />
      </>
    ),
  },
  mergeable: {
    width: 1.4,
    draw: (
      <>
        <path {...solid} d="M3.15 3a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7Zm0 7.3a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7Z" />
        <path d="M3.15 5.7v4.6M3.15 8H8.6" />
        <path {...solid} d="M8.4 5.55 13.1 8 8.4 10.45Z" />
      </>
    ),
  },
  /** Nobody is assigned. */
  unassigned: {
    width: 1.4,
    draw: (
      <>
        <circle {...solid} cx="8" cy="5.2" r="2" />
        <path d="M3.8 12.6c.55-2.15 2-3.2 4.2-3.2s3.65 1.05 4.2 3.2" />
      </>
    ),
  },
  // The counts in the Feedback column, and the filters of its drawer.
  awaiting: { draw: lines('M6.5 4 3 7.5 6.5 11', 'M3 7.5h6a4 4 0 0 1 4 4v1') },
  unread: {
    draw: (
      <>
        <path d="M9 3.5H2.5V11H5v2.5L8 11h5.5V7.5" />
        <circle {...solid} cx="12.6" cy="3.6" r="2" />
      </>
    ),
  },
  comments: { draw: lines('M2.5 3.5h11V11H8l-3 2.5V11H2.5z') },
  unresolved: {
    draw: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <circle {...solid} cx="8" cy="8" r="1.7" />
      </>
    ),
  },
  resolved: {
    draw: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M5.6 8.2 7.3 9.9l3.1-3.5" />
      </>
    ),
  },
  all: { draw: lines('M3 4.5h10M3 8h10M3 11.5h6') },
} satisfies Record<string, Drawing>

export type IconName = keyof typeof ICONS

/** An icon by name. It is decoration: whatever holds it carries the label. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  const { box = 16, width = 1.5, draw }: Drawing = ICONS[name]
  return (
    <svg className={className} viewBox={`0 0 ${box} ${box}`} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      {draw}
    </svg>
  )
}
