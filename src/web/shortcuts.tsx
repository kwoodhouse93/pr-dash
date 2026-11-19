import { useEffect, useRef } from 'react'

const SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: ['/'], does: 'Search the list' },
  { keys: ['j'], does: 'Move down a row' },
  { keys: ['k'], does: 'Move up a row' },
  { keys: ['Enter', 'o'], does: 'Open the pull request on the row' },
  { keys: ['x'], does: 'Expand or collapse the stack on the row' },
  { keys: ['Esc'], does: 'Clear the row, or close what is open' },
  { keys: ['?'], does: 'Show or hide this list' },
]

function listRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('table.prs tr[data-row]')]
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** Keyboard movement over the list rows, and the list of shortcuts. The row in hand is marked with `data-cursor`. */
export function Shortcuts({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const cursor = useRef<{ id: string; index: number } | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    function mark(row: HTMLElement | null, rows: HTMLElement[]) {
      for (const other of rows) other.removeAttribute('data-cursor')
      if (!row) {
        cursor.current = null
        return
      }
      row.setAttribute('data-cursor', '')
      cursor.current = { id: row.dataset.row ?? '', index: rows.indexOf(row) }
      row.scrollIntoView({ block: 'nearest' })
    }
    /** The marked row, or after a redraw replaced it, the row with its id, then the row at its place. */
    function current(rows: HTMLElement[]): HTMLElement | null {
      const held = cursor.current
      if (!held) return null
      return rows.find((row) => row.dataset.row === held.id) ?? rows[Math.min(held.index, rows.length - 1)] ?? null
    }
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
      if (event.key === '?') {
        event.preventDefault()
        if (openRef.current) onClose()
        else onOpen()
        return
      }
      if (openRef.current) {
        if (event.key === 'Escape') onClose()
        return
      }
      if (document.querySelector('[aria-modal="true"]')) return
      const rows = listRows()
      if (rows.length === 0) return
      const row = current(rows)
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        const at = row ? rows.indexOf(row) : -1
        const next = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)
        mark(rows[next] ?? null, rows)
        return
      }
      if (!row) return
      if (event.key === 'Escape') {
        mark(null, rows)
      } else if (event.key === 'Enter' || event.key === 'o') {
        if (event.target instanceof HTMLElement && event.target.closest('button, a')) return
        event.preventDefault()
        row.querySelector<HTMLAnchorElement>('.title-line a')?.click()
      } else if (event.key === 'x' && row.classList.contains('stack')) {
        event.preventDefault()
        row.click()
        // The stack redraws as different rows, so the mark is put back once they exist.
        requestAnimationFrame(() => {
          const redrawn = listRows()
          mark(current(redrawn), redrawn)
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen, onClose])

  if (!open) return null
  return (
    <div
      className="modal-back"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h3 id="shortcuts-title">Keyboard shortcuts</h3>
        <dl>
          {SHORTCUTS.map((item) => (
            <div key={item.does}>
              <dt>
                {item.keys.map((key, index) => (
                  <span key={key}>
                    {index > 0 ? ' or ' : null}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{item.does}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
