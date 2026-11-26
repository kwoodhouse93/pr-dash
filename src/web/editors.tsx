import { useEffect, useRef, useState } from 'react'
import type { Initiative, PullRequest } from '../shared/types.ts'
import { Icon } from './icons.tsx'
import { PopBody, PopHead, useMenuClose } from './menus.tsx'

export function TagEditor({
  primaryKey,
  stackKeys,
  defaultWholeStack,
  prByKey,
  initiatives,
  onAssign,
  onCreate,
  onBack,
}: {
  /** Shown as a step of a menu, this returns to the menu. */
  onBack?: () => void
  primaryKey: string
  stackKeys: string[]
  defaultWholeStack: boolean
  prByKey: Map<string, PullRequest>
  initiatives: Initiative[]
  onAssign: (initiativeId: string, keys: string[], action: 'add' | 'remove') => Promise<void>
  onCreate: (name: string, keys: string[]) => Promise<void>
}) {
  const close = useMenuClose()
  const [whole, setWhole] = useState(defaultWholeStack && stackKeys.length > 1)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const keys = whole ? stackKeys : [primaryKey]

  async function toggle(initiativeId: string, on: boolean) {
    setError(null)
    try {
      await onAssign(initiativeId, keys, on ? 'remove' : 'add')
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the tag')
    }
  }

  return (
    <>
      <PopHead title="Initiative" sub="Local to this dashboard" onBack={onBack} />
      <PopBody>
      <p>A pull request can sit in more than one.</p>
      {stackKeys.length > 1 ? (
        <label className="stack-opt">
          <input type="checkbox" checked={whole} onChange={(event) => setWhole(event.target.checked)} />
          Tag all {stackKeys.length} pull requests in this stack
        </label>
      ) : null}
      {initiatives.length === 0 ? <p>No initiatives yet.</p> : null}
      {initiatives.map((initiative) => (
        <InitiativeCheck
          key={initiative.id}
          initiative={initiative}
          keys={keys}
          prByKey={prByKey}
          onToggle={toggle}
        />
      ))}
      <form
        className="new-initiative"
        onSubmit={async (event) => {
          event.preventDefault()
          setError(null)
          try {
            await onCreate(name, keys)
            close()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not create the initiative')
          }
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New initiative"
          aria-label="New initiative name"
          data-draft
        />
        <button type="submit" className="ghost">
          Add
        </button>
      </form>
      {error ? <p className="launch-error">{error}</p> : null}
      </PopBody>
    </>
  )
}

function InitiativeCheck({
  initiative,
  keys,
  prByKey,
  onToggle,
}: {
  initiative: Initiative
  keys: string[]
  prByKey: Map<string, PullRequest>
  onToggle: (initiativeId: string, on: boolean) => Promise<void>
}) {
  const ref = useRef<HTMLInputElement>(null)
  const tagged = keys.filter((key) => prByKey.get(key)?.initiativeIds.includes(initiative.id)).length
  const on = tagged === keys.length && keys.length > 0
  const mixed = tagged > 0 && tagged < keys.length
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <label className="initiative-row">
      <input ref={ref} type="checkbox" checked={on} onChange={() => void onToggle(initiative.id, on)} />
      <span>{initiative.name}</span>
    </label>
  )
}

export function ManageInitiatives({
  initiatives,
  counts,
  onCreate,
  onRename,
  onDelete,
}: {
  initiatives: Initiative[]
  /** Open pull requests in each initiative, by initiative id. Left out, no counts are shown. */
  counts?: Map<string, number>
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <header className="panel-head">
        <h2>Initiatives</h2>
        <span className="panel-note">Buckets for work that is not a Linear project</span>
      </header>
      {initiatives.map((initiative) => (
        <form
          key={initiative.id}
          className="panel-row initiative-row"
          onSubmit={async (event) => {
            event.preventDefault()
            const next = new FormData(event.currentTarget).get('name')
            if (typeof next !== 'string') return
            setError(null)
            try {
              await onRename(initiative.id, next)
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'Could not rename')
            }
          }}
        >
          <input name="name" defaultValue={initiative.name} aria-label={`Rename ${initiative.name}`} title="Edit the name and press Enter" />
          {counts ? <span className="repo-meta">{prCount(counts.get(initiative.id) ?? 0)}</span> : null}
          <button
            type="button"
            className={confirmId === initiative.id ? 'text-btn delete' : 'icon-btn delete'}
            aria-label={`Delete ${initiative.name}`}
            title={confirmId === initiative.id ? undefined : 'Delete'}
            onClick={async () => {
              if (confirmId !== initiative.id) {
                setConfirmId(initiative.id)
                return
              }
              setError(null)
              try {
                await onDelete(initiative.id)
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not delete')
              }
            }}
          >
            {confirmId === initiative.id ? 'Confirm' : <Icon name="trash" />}
          </button>
        </form>
      ))}
      <form
        className="panel-row new-initiative"
        onSubmit={async (event) => {
          event.preventDefault()
          setError(null)
          try {
            await onCreate(name)
            setName('')
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not create the initiative')
          }
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New initiative"
          aria-label="New initiative name"
        />
        <button type="submit" className="ghost">
          Add
        </button>
      </form>
      {error ? <p className="panel-row repo-error">{error}</p> : null}
    </>
  )
}

function prCount(count: number): string {
  return count === 1 ? '1 PR' : `${count} PRs`
}
