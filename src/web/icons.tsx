const ICONS = {
  refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.75', 'M13.3 2.6v2.9h-2.9'],
  trash: ['M2.8 4.3h10.4', 'M6.3 4.3V2.9h3.4v1.4', 'M4.1 4.3l.6 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.6-8.3', 'M6.7 7v3.8M9.3 7v3.8'],
  x: ['M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4'],
}

/** A line icon for an icon button. The button carries the label. */
export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
