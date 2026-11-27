import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react'
import { REPO_COLORS, REPO_ICONS, repoMarkOf } from '../shared/repo-marks.ts'
import type { RepoMark } from '../shared/types.ts'
import { ClickCard, PopBody, PopHead } from './menus.tsx'

const RepoMarksContext = createContext<Record<string, RepoMark> | undefined>(undefined)

export function RepoMarksProvider({ marks, children }: { marks: Record<string, RepoMark> | undefined; children: ReactNode }) {
  return <RepoMarksContext.Provider value={marks}>{children}</RepoMarksContext.Provider>
}

export function useRepoMark(repo: string): RepoMark {
  return repoMarkOf(repo, useContext(RepoMarksContext))
}

/** Hands the repository's colour to the stylesheet, which adjusts it to the theme. */
function markStyle(mark: RepoMark): CSSProperties {
  return { '--mark': mark.color } as CSSProperties
}

function IconShape({ icon }: { icon: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={REPO_ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The repository's icon in its colour. Decorative unless `label` is set, so put the name beside it or pass the label. */
export function RepoIcon({ repo, label = false }: { repo: string; label?: boolean }) {
  const mark = useRepoMark(repo)
  return (
    <span className="repo-icon" style={markStyle(mark)} title={label ? repo : undefined} role={label ? 'img' : undefined} aria-label={label ? repo : undefined}>
      <IconShape icon={mark.icon} />
    </span>
  )
}

/** The icon as a button that opens the icon and colour choices. Each pick is saved as it is made. */
export function RepoMarkPicker({ repo, onPick }: { repo: string; onPick: (repo: string, mark: RepoMark) => Promise<void> }) {
  const mark = useRepoMark(repo)
  const [error, setError] = useState<string | null>(null)
  function pick(next: RepoMark) {
    setError(null)
    void onPick(repo, next).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'Could not save that icon')
    })
  }
  return (
    <ClickCard
      id={`repo-mark:${repo}`}
      className="repo-mark-btn"
      label={
        <>
          <span className="sr">Change the icon for {repo}</span>
          <span className="repo-icon" style={markStyle(mark)}>
            <IconShape icon={mark.icon} />
          </span>
        </>
      }
    >
      <PopHead title={`Icon for ${repo}`} />
      <PopBody>
        <div className="mark-swatches" role="group" aria-label="Colour">
          {REPO_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="mark-swatch"
              aria-pressed={color === mark.color}
              aria-label={`Colour ${color}`}
              style={{ background: color }}
              onClick={() => pick({ ...mark, color })}
            />
          ))}
        </div>
        <div className="mark-icons" role="group" aria-label="Icon">
          {Object.keys(REPO_ICONS).map((icon) => (
            <button
              key={icon}
              type="button"
              className="mark-icon"
              aria-pressed={icon === mark.icon}
              aria-label={icon}
              title={icon}
              style={markStyle(mark)}
              onClick={() => pick({ ...mark, icon })}
            >
              <IconShape icon={icon} />
            </button>
          ))}
        </div>
        {error ? <p className="launch-error">{error}</p> : null}
      </PopBody>
    </ClickCard>
  )
}
