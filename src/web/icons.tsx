const ICONS = {
  refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.75', 'M13.3 2.6v2.9h-2.9'],
  trash: ['M2.8 4.3h10.4', 'M6.3 4.3V2.9h3.4v1.4', 'M4.1 4.3l.6 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.6-8.3', 'M6.7 7v3.8M9.3 7v3.8'],
  x: ['M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4'],
  back: ['M10 3.5 5.5 8 10 12.5'],
  chevron: ['M6 3.5 10.5 8 6 12.5'],
  copy: ['M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5A1.5 1.5 0 0 1 12 13.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5Z', 'M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5'],
  chat: ['M2.5 3.5h11V11H7l-3 2.5V11H2.5Z'],
  merge: ['M4 5.1v5.8', 'M4 5.5c0 2 2.5 2.5 6.4 2.5', 'M5.6 3.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z', 'M5.6 12.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z', 'M13.6 8a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 0 1 3.2 0Z'],
  spark: ['M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8l4.7-1.5Z'],
  alert: ['M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z', 'M8 4.8v3.6M8 11v.2'],
  link: ['M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8', 'M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.300 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8'],
  tag: ['M2 2.5h5.5l6.2 6.2-5 5L2.5 7.5Z', 'M6.2 5.3a.9.9 0 1 1-1.8 0a.9.9 0 0 1 1.8 0Z'],
}

export type IconName = keyof typeof ICONS

/** A line icon for an icon button. The button carries the label. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
