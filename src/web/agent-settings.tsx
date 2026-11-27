import { useEffect, useState } from 'react'
import {
  AGENT_PROVIDERS,
  environmentFor,
  environmentName,
  LOCAL_ENVIRONMENT,
  providerLabel,
  type AgentHealth,
  type AgentSettings,
  type T3Environment,
} from '../shared/agents.ts'
import type { AgentProviderId, Snapshot } from '../shared/types.ts'
import { api } from './api.ts'
import { Icon } from './icons.tsx'

type Row = AgentSettings['repos'][number]
type RepoAgentChange = { provider: AgentProviderId | null; checkout: string | null; environmentId?: string | null }

/** Whether this page is in the desktop app, which says so itself. It pairs with T3 Code without showing a page for it. */
function inDesktopApp(): boolean {
  return (window as { prDashDesktop?: unknown }).prDashDesktop === true
}

function healthLabel(health: AgentHealth): string {
  if (health.state === 'ready') return 'Ready'
  return health.state === 'unconfigured' ? 'Not set up' : 'Not answering'
}

/**
 * Which provider starts agents, and where T3 Code works for each repository.
 * `repos` is the list being synced; the panel loads again when it changes.
 */
export function AgentSettingsPanel({
  repos,
  onSnapshot,
  t3Origin = null,
  onT3Origin = () => {},
  pairPrompt = true,
}: {
  repos: string[]
  onSnapshot: (snapshot: Snapshot) => void
  /** The T3 Code this browser is paired with, or null. */
  t3Origin?: string | null
  onT3Origin?: (origin: string | null) => void
  /** False once the user chose not to be asked to pair, so being unpaired is not flagged. */
  pairPrompt?: boolean
}) {
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
  const running = settings?.t3Origin ?? null
  // T3 Code moved to another address since pairing: the pairing was with the old one.
  const stale = t3Origin !== null && running !== null && t3Origin !== running
  const pairing: Pairing = stale ? 'stale' : t3Origin ? 'paired' : 'unpaired'
  const flagged = pairing === 'stale' || (pairing === 'unpaired' && pairPrompt)
  const environments = settings?.t3.environments ?? []
  const fallback = settings?.t3.defaultEnvironmentId ?? null
  // Some repository's threads start on another environment, which PR Dash reaches through its own sign-in to T3 Code.
  const remote = settings?.repos.some((row) => usesT3(row) && environmentFor(fallback, row.environmentId) !== null) ?? false
  const unconnected = remote && !settings?.t3.connectedUntil

  return (
    <section className="panel agent-settings">
      <header className="panel-head">
        <h2>Agents</h2>
        <span className="panel-note">Where an agent runs when you start one from a pull request</span>
        <button type="button" className="icon-btn" aria-label="Check again" title="Check again" disabled={busy} onClick={() => void check()}>
          <Icon name="refresh" />
        </button>
      </header>
      <div className="panel-row setting">
        <h3>Start agents with</h3>
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
        <div key={id} className="agent-provider" data-state={health.state} data-flagged={id === 't3' && (flagged || unconnected) ? '' : undefined}>
          <div className="agent-health">
            <i className="agent-health-dot" aria-hidden="true" />
            <span className="agent-health-name">
              {providerLabel(id)}
              {health.detail && health.state === 'ready' ? <span className="panel-note">{health.detail}</span> : null}
            </span>
            <span className="agent-health-state">{healthLabel(health)}</span>
          </div>
          {health.detail && health.state !== 'ready' ? <p className="agent-provider-line panel-note">{health.detail}</p> : null}
          {id === 't3' ? <T3Pairing running={running} paired={t3Origin} pairing={pairing} flagged={flagged} onPaired={onT3Origin} /> : null}
          {id === 't3' && (environments.length > 0 || fallback) ? (
            <T3Environments
              t3={settings.t3}
              running={running}
              needed={remote}
              busy={busy}
              onDefault={(environmentId) => void save(() => api.setDefaultEnvironment(environmentId))}
              onDisconnect={() => void save(() => api.disconnectT3())}
              onCheck={() => void check()}
            />
          ) : null}
        </div>
      ))}
      {error ? <p className="panel-row repo-error">{error}</p> : null}
      {settings && settings.repos.length > 0 ? (
        <>
          <div className="panel-row agent-repos-head">
            <h3>Repositories</h3>
            <span className="panel-note">Override defaults per repo</span>
          </div>
          <div className="agent-cols" aria-hidden="true" data-environments={environments.length > 0 ? '' : undefined}>
            <span>Repository</span>
            <span>Agent</span>
            {environments.length > 0 ? <span>Runs on</span> : null}
            <span>T3 Code folder</span>
          </div>
          <ul className="agent-repos" aria-label="Agent provider for each repository" data-environments={environments.length > 0 ? '' : undefined}>
            {settings.repos.map((row) => (
              <RepoRow
                key={row.repo}
                row={row}
                needsCheckout={usesT3(row)}
                environments={environments}
                fallback={fallback}
                busy={busy}
                onSave={(agent) => save(() => api.setRepoAgent(row.repo, agent))}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

type Pairing = 'paired' | 'stale' | 'unpaired'

/**
 * Where T3 Code threads start, and PR Dash's own sign-in to T3 Code. The `t3` command only
 * starts threads on this machine, so a thread on a linked environment goes through that sign-in.
 */
function T3Environments({
  t3,
  running,
  needed,
  busy,
  onDefault,
  onDisconnect,
  onCheck,
}: {
  t3: AgentSettings['t3']
  running: string | null
  /** Some repository's threads start on another environment, so being signed out is flagged. */
  needed: boolean
  busy: boolean
  onDefault: (environmentId: string | null) => void
  onDisconnect: () => void
  onCheck: () => void
}) {
  const [asked, setAsked] = useState<{ code: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const connected = t3.connectedUntil !== null

  // The approval happens in another tab. Coming back to this one is the moment to look again.
  useEffect(() => {
    if (!asked) return
    window.addEventListener('focus', onCheck)
    return () => window.removeEventListener('focus', onCheck)
  })
  useEffect(() => setAsked(null), [t3.connectedUntil])

  async function connect() {
    setConnecting(true)
    setError(null)
    // A browser only allows a tab opened during the click. The desktop app opens one whenever asked.
    const tab = inDesktopApp() ? null : window.open('', '_blank')
    try {
      const made = await api.connectT3()
      if (tab) tab.location.replace(made.authorizeUrl)
      else window.open(made.authorizeUrl, '_blank')
      setAsked({ code: made.pairingCode })
    } catch (caught) {
      tab?.close()
      setError(caught instanceof Error ? caught.message : 'Could not connect to T3 Code')
    } finally {
      setConnecting(false)
    }
  }

  const chosen = t3.environments.find((environment) => environment.id === t3.defaultEnvironmentId)
  const stopped = running ? undefined : 'T3 Code is not running on this machine'
  return (
    <>
      <div className="agent-provider-line">
        <span>Start threads on</span>
        <select
          className="select"
          aria-label="Where T3 Code threads start"
          value={t3.defaultEnvironmentId ?? ''}
          disabled={busy}
          onChange={(event) => onDefault(event.target.value || null)}
        >
          <option value="">This machine</option>
          {t3.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environmentOption(environment)}
            </option>
          ))}
          {t3.defaultEnvironmentId && !chosen ? <option value={t3.defaultEnvironmentId}>An environment that is no longer linked</option> : null}
        </select>
      </div>
      {chosen && !chosen.reachable && chosen.detail ? <p className="agent-provider-line agent-problem">{chosen.detail}</p> : null}
      <div className="agent-provider-line">
        <span
          className="agent-connection"
          data-state={connected ? 'connected' : 'unconnected'}
          data-flagged={needed && !connected ? '' : undefined}
          title="PR Dash signs in to T3 Code on this machine to start threads on a linked environment. T3 Code asks again about once a month."
        >
          {t3.connectedUntil
            ? `Connected to T3 Code until ${new Date(t3.connectedUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
            : 'Not connected to T3 Code'}
        </span>
        <button type="button" className="ghost" disabled={busy || connecting || !running} title={stopped} onClick={() => void connect()}>
          {connecting ? 'Connecting…' : connected ? 'Connect again' : 'Connect'}
        </button>
        {connected ? (
          <button type="button" className="text-btn" disabled={busy} onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
      </div>
      {asked ? (
        <p className="agent-provider-line panel-note">
          <span>
            Approve PR Dash in the T3 Code tab that opened.
            {asked.code ? (
              <>
                {' '}
                If it asks for a pairing code, use <code className="agent-code">{asked.code}</code>
              </>
            ) : null}
          </span>
          {asked.code ? (
            <button type="button" className="text-btn" onClick={() => void navigator.clipboard?.writeText(asked.code ?? '')}>
              Copy code
            </button>
          ) : null}
        </p>
      ) : null}
      {error ? <p className="agent-provider-line repo-error">{error}</p> : null}
    </>
  )
}

function environmentOption(environment: T3Environment): string {
  return environment.reachable ? environmentName(environment) : `${environmentName(environment)}, not answering`
}

/**
 * Pairs this browser with the T3 Code on this machine, so a thread opens in a tab here
 * instead of handing off to the T3 Code app. `running` is where that T3 Code answers now.
 */
function T3Pairing({
  running,
  paired,
  pairing,
  flagged,
  onPaired,
}: {
  running: string | null
  paired: string | null
  pairing: Pairing
  flagged: boolean
  onPaired: (origin: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [code, setCode] = useState('')

  async function pair() {
    setBusy(true)
    setError(null)
    // The desktop app takes the pairing link and pairs out of sight, so it needs no tab.
    // A browser has to visit the link, and only allows a tab opened during the click.
    const desktop = inDesktopApp()
    const tab = desktop ? null : window.open('', '_blank')
    try {
      const made = await api.pairT3()
      if (tab) tab.location.replace(made.pairUrl)
      else if (desktop) window.open(made.pairUrl, '_blank')
      else window.location.assign(made.pairUrl)
      onPaired(made.origin)
    } catch (caught) {
      tab?.close()
      setError(caught instanceof Error ? caught.message : 'Could not pair with T3 Code')
      setManual(true)
    } finally {
      setBusy(false)
    }
  }

  function pairWithCode() {
    const token = code.trim()
    if (!token || !running) return
    window.open(`${running}/pair#token=${encodeURIComponent(token)}`, '_blank')
    onPaired(running)
    setCode('')
    setManual(false)
    setError(null)
  }

  const stopped = running ? undefined : 'T3 Code is not running on this machine'
  return (
    <>
      {manual && !paired ? (
        <form
          className="agent-provider-line"
          onSubmit={(event) => {
            event.preventDefault()
            pairWithCode()
          }}
        >
          <input
            className="search"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Pairing code"
            title={stopped ?? 'From `t3 pair` or T3 Code’s settings'}
            aria-label="T3 Code pairing code"
            spellCheck={false}
            autoFocus
            disabled={!running}
          />
          <button type="submit" className="text-btn" disabled={!running || !code.trim()}>
            Pair
          </button>
          <button type="button" className="text-btn" onClick={() => setManual(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="agent-provider-line">
          <span
            className="agent-pairing"
            data-flagged={flagged ? '' : undefined}
            data-state={pairing}
            title={
              pairing === 'stale'
                ? 'T3 Code has moved since this browser was paired with it. Pair again to open threads in a tab here.'
                : pairing === 'unpaired'
                  ? 'Pair to open T3 Code threads in a tab here.'
                  : undefined
            }
          >
            {pairing === 'stale' ? 'Pairing out of date' : paired ? `Paired with ${paired.replace(/^https?:\/\//, '')}` : 'Not paired'}
          </span>
          <button type="button" className="ghost" disabled={busy || !running} title={stopped} onClick={() => void pair()}>
            {busy ? 'Pairing…' : paired ? 'Pair again' : 'Pair'}
          </button>
          {paired ? (
            <button
              type="button"
              className="text-btn"
              disabled={busy}
              title="Stops opening threads here. To end the pairing itself, revoke PR Dash in T3 Code."
              onClick={() => onPaired(null)}
            >
              Forget
            </button>
          ) : (
            <button type="button" className="text-btn" disabled={busy || !running} title={stopped} onClick={() => setManual(true)}>
              Enter a code
            </button>
          )}
        </div>
      )}
      {error ? <p className="agent-provider-line repo-error">{error}</p> : null}
    </>
  )
}

function RepoRow({
  row,
  needsCheckout,
  environments,
  fallback,
  busy,
  onSave,
}: {
  row: Row
  /** This repository's agents start in T3 Code, which needs a folder to work in. */
  needsCheckout: boolean
  /** The environments T3 Code is linked to. With none, every thread starts on this machine and there is nothing to choose. */
  environments: T3Environment[]
  /** Where threads start when this repository does not say. Null is this machine. */
  fallback: string | null
  busy: boolean
  onSave: (agent: RepoAgentChange) => Promise<void>
}) {
  const environmentId = environmentFor(fallback, row.environmentId)
  const environment = environments.find((item) => item.id === environmentId)
  // The folder in use: the one set here, or else the folder of T3 Code's own project.
  const current = row.checkout ?? row.project?.folder ?? ''
  const [draft, setDraft] = useState(current)
  const [editing, setEditing] = useState(false)
  useEffect(() => setDraft(current), [current])

  function cancel() {
    setDraft(current)
    setEditing(false)
  }

  function submit() {
    const typed = draft.trim()
    // Empty, or T3 Code's own project folder, means no folder set here.
    const next = typed && typed !== row.project?.folder ? typed : null
    setEditing(false)
    if (next !== row.checkout) void onSave({ provider: row.provider, checkout: next })
  }

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
      {needsCheckout && environments.length > 0 ? (
        <select
          className="select"
          aria-label={`Where T3 Code threads start for ${row.repo}`}
          value={row.environmentId ?? ''}
          disabled={busy}
          onChange={(event) => void onSave({ provider: row.provider, checkout: row.checkout, environmentId: event.target.value || null })}
        >
          <option value="">Default</option>
          <option value={LOCAL_ENVIRONMENT}>This machine</option>
          {environments.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
          {row.environmentId && row.environmentId !== LOCAL_ENVIRONMENT && !environments.some((item) => item.id === row.environmentId) ? (
            <option value={row.environmentId}>No longer linked</option>
          ) : null}
        </select>
      ) : null}
      {!needsCheckout ? null : environmentId ? (
        // Another environment works in its own project for the repository. There is no folder to set from here.
        <>
          {row.project ? (
            <span className="agent-folder" title={row.project.folder}>
              <bdi>{row.project.folder}</bdi>
            </span>
          ) : (
            <span
              className="agent-folder"
              data-missing=""
              title="Shown once PR Dash is connected to T3 Code and that environment has a project for this repository."
            >
              No project found on {environment?.label ?? 'that environment'}
            </span>
          )}
          <span className="agent-folder-actions" />
        </>
      ) : editing ? (
        <form
          className="agent-folder-form"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <input
            className="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancel()
            }}
            placeholder="Folder for T3 Code, such as ~/code/app"
            aria-label={`Folder T3 Code works in for ${row.repo}`}
            spellCheck={false}
            autoFocus
            disabled={busy}
          />
          <span className="agent-folder-actions">
            <button type="submit" className="text-btn" disabled={busy}>
              Save
            </button>
            <button type="button" className="text-btn" onClick={cancel}>
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <>
          {current ? (
            <span className="agent-folder" data-set={row.checkout ? '' : undefined} title={current}>
              <bdi>{current}</bdi>
            </span>
          ) : (
            <span className="agent-folder" data-missing="" title="Add this repository’s folder as a project in T3 Code, or set the folder here.">
              No T3 Code project
            </span>
          )}
          <span className="agent-folder-actions">
            <button type="button" className="text-btn" disabled={busy} onClick={() => setEditing(true)}>
              {current ? 'Change' : 'Set folder'}
            </button>
            {row.checkout && row.project ? (
              <button
                type="button"
                className="text-btn"
                disabled={busy}
                title={`Back to T3 Code’s project folder, ${row.project.folder}`}
                onClick={() => void onSave({ provider: row.provider, checkout: null })}
              >
                Reset
              </button>
            ) : null}
          </span>
        </>
      )}
      {needsCheckout && row.checkoutProblem && !editing ? <p className="agent-problem">{row.checkoutProblem}</p> : null}
    </li>
  )
}
