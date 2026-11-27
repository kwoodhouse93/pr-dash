import type { CSSProperties } from 'react'
import { ageFill, ageHeat, cobwebTier, formatAgo, formatCount, formatExact, formatWhen, graphitePrUrl, prCopyId } from '../format.ts'
import { HoverCard, PopBody, PopHead } from '../menus.tsx'
import { copyPlain } from './clipboard.ts'

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
        <CopyIcon />
      </button>
    </td>
  )
}

function CopyIcon() {
  return (
    <svg className="copy-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.75 5.25V3.15A1.15 1.15 0 0 0 9.6 2H3.15A1.15 1.15 0 0 0 2 3.15V9.6c0 .64.51 1.15 1.15 1.15H5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function OpenLinks({ url, repo, number }: { url: string; repo: string; number: number }) {
  return (
    <td className="open">
      <span className="open-links">
        <a href={url} target="_blank" rel="noreferrer" title="Open in GitHub" aria-label={`Open #${number} in GitHub`}>
          <GithubIcon />
        </a>
        <a
          href={graphitePrUrl(repo, number)}
          target="_blank"
          rel="noreferrer"
          title="Open in Graphite"
          aria-label={`Open #${number} in Graphite`}
        >
          <GraphiteIcon />
        </a>
      </span>
    </td>
  )
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  )
}

export function RobotIcon() {
  return (
    <svg className="robot-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.6v2.2" />
      <rect x="3" y="3.8" width="10" height="8.4" rx="2.2" />
      <path d="M1.2 7.2v2.2M14.8 7.2v2.2M6.4 14.4h3.2" />
      <path d="M6 7.4v1.4M10 7.4v1.4" />
    </svg>
  )
}

function GraphiteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1.2 2.4 4.4v7.2L8 14.8l5.6-3.2V4.4L8 1.2Zm0 1.85 3.85 2.2v.01L8 7.45 4.15 5.26 8 3.05Zm-4.4 3.4 3.85 2.2v4.35L3.6 10.8V6.45Zm5 6.55V8.65l3.85-2.2v4.35L8.6 13Z"
      />
    </svg>
  )
}

export function Size({ additions, deletions, files }: { additions: number; deletions: number; files: number }) {
  const fileLabel = `${files.toLocaleString('en-GB')} ${files === 1 ? 'file' : 'files'}`
  return (
    <>
      <td className="size add">+{formatCount(additions)}</td>
      <td className="size del">−{formatCount(deletions)}</td>
      <td className="size files" title={fileLabel} aria-label={fileLabel}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 1.75h5.15L13.1 5.7V13.2c0 .58-.47 1.05-1.05 1.05H4A1.05 1.05 0 0 1 2.95 13.2V2.8C2.95 2.22 3.42 1.75 4 1.75Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9.05 1.9v3.85h3.85" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
  const heading = !readyAt ? `Draft, opened ${formatAgo(createdAt)}` : readyAt === createdAt ? `Opened ${formatAgo(createdAt)}` : `Ready for review ${formatAgo(readyAt)}`
  const label = (
    <>
      <span className="sr">{heading}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        {readyAt ? <circle className="arc" cx="8" cy="8" r="6" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0.04, ageFill(readyAt)))} /> : null}
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
        {web ? <p>{web === 3 ? 'Over a month. The spider has moved in.' : web === 2 ? 'Over two weeks, and gathering cobwebs.' : 'Over five days. The first cobweb.'}</p> : null}
        </PopBody>
      </HoverCard>
    </td>
  )
}

/** Points along the four threads a web hangs from, out of the cell's top corner. */
const SPOKES = [[28, 3], [23, 14], [14, 23], [3, 28]] as const

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
