import type { CSSProperties } from 'react'
import { ageFill, ageHeat, cobwebTier, formatAgo, formatCount, formatExact, formatWhen, graphitePrUrl, prCopyId } from '../format.ts'
import { HoverCard, PopBody, PopHead } from '../menus.tsx'
import { copyPlain } from './clipboard.ts'
import { Icon } from '../icons.tsx'

export function CopyNumber({ repoName, number }: { repoName: string; number: number }) {
  const id = prCopyId(repoName, number)
  return (
    <td className="num">
      <button
        type="button"
        className="num-copy"
        title={`Copy ${id}`}
        aria-label={`Copy ${id}`}
        onClick={(event) => {
          event.stopPropagation()
          void copyPlain(id, `Copied ${id}`)
        }}
      >
        <span className="num-value">{number}</span>
        <Icon name="copyNumber" className="copy-icon" />
      </button>
    </td>
  )
}

export function OpenLinks({ url, repo, number }: { url: string; repo: string; number: number }) {
  return (
    <td className="open">
      <span className="open-links">
        <a href={url} target="_blank" rel="noreferrer" title="Open in GitHub" aria-label={`Open #${number} in GitHub`}>
          <Icon name="github" />
        </a>
        <a href={graphitePrUrl(repo, number)} target="_blank" rel="noreferrer" title="Open in Graphite" aria-label={`Open #${number} in Graphite`}>
          <Icon name="graphite" />
        </a>
      </span>
    </td>
  )
}

export function Size({ additions, deletions, files }: { additions: number; deletions: number; files: number }) {
  const fileLabel = `${files.toLocaleString('en-GB')} ${files === 1 ? 'file' : 'files'}`
  return (
    <>
      <td className="size add">+{formatCount(additions)}</td>
      <td className="size del">−{formatCount(deletions)}</td>
      <td className="size files" title={fileLabel} aria-label={fileLabel}>
        <Icon name="file" />
        {formatCount(files)}
      </td>
    </>
  )
}

const RING = 2 * Math.PI * 6

/**
 * Time since review could start, as a ring that fills over two days and takes the age's colour. The time itself is in the card.
 * A draft has a dotted ring that never fills, for the time since it was opened.
 */
export function Age({ id, readyAt, createdAt }: { id: string; readyAt: string | null; createdAt: string }) {
  const heat = ageHeat(readyAt)
  const web = cobwebTier(readyAt)
  const since = readyAt ?? createdAt
  const heading = !readyAt
    ? `Draft, opened ${formatAgo(createdAt)}`
    : readyAt === createdAt
      ? `Opened ${formatAgo(createdAt)}`
      : `Ready for review ${formatAgo(readyAt)}`
  const label = (
    <>
      <span className="sr">{heading}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        {readyAt ? (
          <circle className="arc" cx="8" cy="8" r="6" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0.04, ageFill(readyAt)))} />
        ) : null}
      </svg>
    </>
  )
  return (
    <td className={`when age ${heat.level}`} style={{ '--heat': `${Math.round(heat.warmth * 100)}%` } as CSSProperties}>
      {web ? <Cobweb tier={web} /> : null}
      <HoverCard id={id} className={`age-ring${readyAt ? '' : ' draft'}`} label={label}>
        <PopHead title={heading} />
        <PopBody>
          <p className="age-line">{formatExact(since)}</p>
          {readyAt && readyAt !== createdAt ? <p>Opened {formatExact(createdAt)}</p> : null}
          {web ? (
            <p>
              {web === 3
                ? 'Over a month. The spider has moved in.'
                : web === 2
                  ? 'Over two weeks, and gathering cobwebs.'
                  : 'Over five days. The first cobweb.'}
            </p>
          ) : null}
        </PopBody>
      </HoverCard>
    </td>
  )
}

/** Points along the four threads a web hangs from, out of the cell's top corner. */
const SPOKES = [
  [28, 3],
  [23, 14],
  [14, 23],
  [3, 28],
] as const

const WEB_RINGS = { 1: [0.5, 0.85], 2: [0.34, 0.6, 0.86], 3: [0.24, 0.44, 0.64, 0.84] } as const

function Cobweb({ tier }: { tier: 1 | 2 | 3 }) {
  const at = (spoke: readonly [number, number], far: number) => `${(spoke[0] * far).toFixed(1)} ${(spoke[1] * far).toFixed(1)}`
  // Each ring sags towards the corner between one thread and the next.
  const rings = WEB_RINGS[tier].map((far) =>
    SPOKES.map((spoke, index) => {
      if (index === 0) return `M${at(spoke, far)}`
      const before = SPOKES[index - 1]!
      return `Q${at([(spoke[0] + before[0]) / 2, (spoke[1] + before[1]) / 2], far * 0.8)} ${at(spoke, far)}`
    }).join(''),
  )
  return (
    <svg className={`cobweb tier-${tier}`} viewBox="0 0 30 32" aria-hidden="true">
      <path d={`${SPOKES.map((spoke) => `M0 0L${spoke[0]} ${spoke[1]}`).join('')}${rings.join('')}`} />
      {tier === 3 ? (
        <>
          <path d="M3.4 23.5V29" />
          <circle className="spider" cx="3.4" cy="29" r="1.7" />
        </>
      ) : null}
    </svg>
  )
}

export function When({ iso }: { iso: string }) {
  return (
    <td className="when" title={formatExact(iso)}>
      {formatWhen(iso)}
    </td>
  )
}

export function Authors({ people }: { people: { login: string; avatarUrl: string | null }[] }) {
  if (people.length === 0) return <span className="author">Unknown</span>
  const shown = people.slice(0, 3)
  const label = people.length === 1 ? people[0]!.login : `${people.length} authors`
  return (
    <span className="author" title={people.map((person) => person.login).join(', ')}>
      <span className="avatars">
        {shown.map((person) =>
          person.avatarUrl ? (
            <img key={person.login} src={person.avatarUrl} alt="" />
          ) : (
            <span key={person.login} className="avatar fallback" aria-hidden="true">
              {person.login.slice(0, 1).toUpperCase()}
            </span>
          ),
        )}
      </span>
      <span className="author-name">{label}</span>
    </span>
  )
}
