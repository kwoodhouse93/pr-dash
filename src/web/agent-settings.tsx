import { useEffect, useState } from 'react'
import { AGENT_PROVIDERS, providerLabel, type AgentHealth, type AgentSettings } from '../shared/agents.ts'
import type { AgentProviderId, Snapshot } from '../shared/types.ts'
import { api } from './api.ts'

type Row = AgentSettings['repos'][number]

function healthLabel(health: AgentHealth): string {
  if (health.state === 'ready') return 'Ready'
  return health.state === 'unconfigured' ? 'Not set up' : 'Not answering'
}

/**
 * Which provider starts agents, and where T3 Code works for each repository.
 * `repos` is the list being synced; the panel loads again when it changes.
 */
export function AgentSettingsPanel({ repos, onSnapshot }: { repos: string[]; onSnapshot: (snapshot: Snapshot) => void }) {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reposKey = repos.join('|')

  useEffect(() => {
    let cancel = false
    void api
      .agentSettings()
      .then((next) => {
        if (!cancel) setSettings(next)
      })
      .catch((caught) => {
        if (!cancel) setError(caught instanceof Error ? caught.message : 'Could not load agent settings')
      })
    return () => {
      cancel = true
    }
  }, [reposKey])

  async function save(change: () => Promise<{ settings: AgentSettings; snapshot: Snapshot }>) {
    setBusy(true)
    setError(null)
    try {
      const saved = await change()
      setSettings(saved.settings)
      onSnapshot(saved.snapshot)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save agent settings')
    } finally {
      setBusy(false)
    }
  }

  async function check() {
    setBusy(true)
    setError(null)
    try {
      setSettings(await api.agentSettings())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load agent settings')
    } finally {
      setBusy(false)
    }
  }

  const usesT3 = (row: Row) => (row.provider ?? settings?.defaultProvider) === 't3'

  return (
    <section className="panel agent-settings">
      <header className="panel-head">
        <h2>Agents</h2>
        <span className="panel-note">Where an agent runs when you start one from a pull request</span>
      </header>
      <div className="panel-row setting">
        <div>
          <h3>Start agents with</h3>
          <p className="panel-note">{AGENT_PROVIDERS.find((provider) => provider.id === settings?.defaultProvider)?.where ?? ' '}</p>
        </div>
        <div className="segmented" role="group" aria-label="Default agent provider">
          {AGENT_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              aria-pressed={settings?.defaultProvider === provider.id}
              disabled={busy || !settings}
              onClick={() => void save(() => api.setDefaultAgent(provider.id))}
            >
              {provider.label}
            </button>
          ))}
        </div>
      </div>
      {settings?.providers.map(({ id, health }) => (
        <div key={id} className="panel-row agent-health" data-state={health.state}>
          <i className="agent-health-dot" aria-hidden="true" />
          <span className="repo-name">{providerLabel(id)}</span>
          <span className="agent-health-state">{healthLabel(health)}</span>
          {health.detail ? <span className="panel-note">{health.detail}</span> : null}
        </div>
      ))}
      {settings ? (
        <div className="panel-row agent-check">
          <button type="button" className="text-btn" disabled={busy} onClick={() => void check()}>
            {busy ? 'Checking…' : 'Check again'}
          </button>
        </div>
      ) : null}
      {error ? <p className="panel-row repo-error">{error}</p> : null}
      {settings && settings.repos.length > 0 ? (
        <ul className="agent-repos" aria-label="Agent provider for each repository">
          {settings.repos.map((row) => (
            <RepoRow
              key={row.repo}
              row={row}
              needsCheckout={usesT3(row)}
              busy={busy}
              onSave={(agent) => save(() => api.setRepoAgent(row.repo, agent))}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function RepoRow({
  row,
  needsCheckout,
  busy,
  onSave,
}: {
  row: Row
  /** This repository's agents start in T3 Code, which needs a folder to work in. */
  needsCheckout: boolean
  busy: boolean
  onSave: (agent: { provider: AgentProviderId | null; checkout: string | null }) => Promise<void>
}) {
  const [draft, setDraft] = useState(row.checkout ?? '')
  const [editing, setEditing] = useState(false)
  useEffect(() => setDraft(row.checkout ?? ''), [row.checkout])
  const changed = draft.trim() !== (row.checkout ?? '')
  // T3 Code's own project is enough. The folder box is for a repository without one, or to work somewhere else.
  const typing = editing || row.checkout != null || (needsCheckout && !row.project)
  const problem =
    row.checkoutProblem ??
    (needsCheckout && !row.checkout && !row.project ? 'T3 Code has no project for this repository. Add its folder as a project in T3 Code, or give the folder here.' : null)

  return (
    <li className="panel-row agent-repo">
      <span className="repo-name">{row.repo}</span>
      <select
        className="select"
        aria-label={`Agent provider for ${row.repo}`}
        value={row.provider ?? ''}
        disabled={busy}
        onChange={(event) => void onSave({ provider: (event.target.value || null) as AgentProviderId | null, checkout: row.checkout })}
      >
        <option value="">Default</option>
        {AGENT_PROVIDERS.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </select>
      {typing ? (
        <form
          className="agent-checkout"
          onSubmit={(event) => {
            event.preventDefault()
            setEditing(false)
            if (changed) void onSave({ provider: row.provider, checkout: draft.trim() || null })
          }}
        >
          <input
            className="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={row.project ? `Leave empty to use ${row.project.folder}` : 'Folder for T3 Code, such as ~/code/app'}
            aria-label={`Folder T3 Code works in for ${row.repo}`}
            spellCheck={false}
            disabled={busy}
          />
          {changed ? (
            <button type="submit" className="text-btn" disabled={busy}>
              Save
            </button>
          ) : null}
        </form>
      ) : (
        <p className="agent-checkout agent-project">
          {row.project ? (
            <>
              <span className="panel-note" title={row.project.folder}>
                T3 Code project {row.project.title} · {row.project.folder}
              </span>
              <button type="button" className="text-btn" disabled={busy} onClick={() => setEditing(true)}>
                Use another folder
              </button>
            </>
          ) : null}
        </p>
      )}
      {problem && !changed ? <p className="agent-problem">{problem}</p> : null}
    </li>
  )
}
