import { useEffect, useRef, useState } from 'react'
import {
  AGENT_PROVIDERS,
  type AgentChecks,
  type AgentHealth,
  DEFAULT_ROUTING,
  environmentFor,
  environmentName,
  LOCAL_ENVIRONMENT,
  providerLabel,
  type T3Environment,
} from '../shared/agents.ts'
import type { AgentProviderId, AgentRouting, Snapshot } from '../shared/types.ts'
import { api } from './api.ts'
import { Icon } from './icons.tsx'

/** One repository's line: what was chosen for it, and what T3 Code said about that, or null until it has. */
type Row = {
  repo: string
  /** Null follows the default. */
  provider: AgentProviderId | null
  /** Where this repository's threads start: an environment, `LOCAL_ENVIRONMENT`, or null to follow the default. */
  environmentId: string | null
  /** A folder set by hand for T3 Code to work in on this machine. */
  checkout: string | null
  check: AgentChecks['repos'][string] | null
}
type RepoAgentChange = { provider: AgentProviderId | null; checkout: string | null; environmentId?: string | null }
/** T3 Code's environments and PR Dash's sign-in to it, with where threads start by default. */
type T3Setup = AgentChecks['t3'] & { defaultEnvironmentId: string | null }

/** Whether this page is in the desktop app, which says so itself. It pairs with T3 Code without showing a page for it. */
function inDesktopApp(): boolean {
  return (window as { prDashDesktop?: unknown }).prDashDesktop === true
}

function healthLabel(health: AgentHealth): string {
  if (health.state === 'ready') return 'Ready'
  return health.state === 'unconfigured' ? 'Not set up' : 'Not answering'
}

function pairingOf(checks: AgentChecks | null, t3Origin: string | null): Pairing {
  const running = checks?.t3Origin ?? null
  // T3 Code moved to another address since pairing: the pairing was with the old one.
  if (t3Origin !== null && running !== null && t3Origin !== running) return 'stale'
  return t3Origin ? 'paired' : 'unpaired'
}

function pairingFlagged(pairing: Pairing, pairPrompt: boolean): boolean {
  return pairing === 'stale' || (pairing === 'unpaired' && pairPrompt)
}

/** Each repository with what was chosen for it, and T3 Code's answer where that answer is still about the same choice. */
function rowsOf(repos: string[], routing: AgentRouting, checks: AgentChecks | null): Row[] {
  const fallback = routing.defaultEnvironmentId ?? null
  return repos.map((repo) => {
    const environmentId = routing.environments?.[repo] ?? null
    const checkout = routing.checkouts?.[repo] ?? null
    const said = checks?.repos[repo]
    // An answer about another environment or folder says nothing about this one.
    const check = said && said.checkout === checkout && said.environmentId === environmentFor(fallback, environmentId) ? said : null
    return { repo, provider: routing.repos[repo] ?? null, environmentId, checkout, check }
  })
}

/** Some repository's T3 Code threads start on another environment, which PR Dash reaches through its own sign-in to T3 Code. */
function startsRemotely(rows: Row[], routing: AgentRouting): boolean {
  const fallback = routing.defaultEnvironmentId ?? null
  return rows.some((row) => (row.provider ?? routing.defaultProvider) === 't3' && environmentFor(fallback, row.environmentId) !== null)
}

/**
 * True when a provider that some repository starts agents with is not ready, or T3 Code is one of them and
 * its pairing or sign-in wants a look. False until the providers have answered.
 */
export function agentsNeedAttention(
  repos: string[],
  routing: AgentRouting | undefined,
  checks: AgentChecks | null,
  t3Origin: string | null,
  pairPrompt: boolean,
): boolean {
  if (!checks) return false
  const chosen = routing ?? DEFAULT_ROUTING
  const rows = rowsOf(repos, chosen, checks)
  const used = new Set<AgentProviderId>([chosen.defaultProvider, ...rows.flatMap((row) => row.provider ?? [])])
  if (checks.providers.some(({ id, health }) => used.has(id) && health.state !== 'ready')) return true
  if (!used.has('t3')) return false
  return pairingFlagged(pairingOf(checks, t3Origin), pairPrompt) || (startsRemotely(rows, chosen) && !checks.t3.connectedUntil)
}

/**
 * Which provider starts agents, and where T3 Code works for each repository.
 *
 * The choices come with the snapshot, as `routing`, so the card is drawn in full at once: a line for each
 * provider and each of `repos`. Whether a provider is ready, what T3 Code is linked to and which folder it
 * has are asked for separately and fill in when they arrive. `checks` is the last answer, kept by the
 * caller so a return to Settings shows it straight away; null until the first one.
 */
export function AgentSettingsPanel({
  repos,
  routing = DEFAULT_ROUTING,
  checks,
  onChecks,
  onSnapshot,
  t3Origin = null,
  onT3Origin = () => {},
  pairPrompt = true,
}: {
  repos: string[]
  routing?: AgentRouting
  checks: AgentChecks | null
  onChecks: (checks: AgentChecks) => void
  onSnapshot: (snapshot: Snapshot) => void
  /** The T3 Code this browser is paired with, or null. */
  t3Origin?: string | null
  onT3Origin?: (origin: string | null) => void
  /** False once the user chose not to be asked to pair, so being unpaired is not flagged. */
  pairPrompt?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  // Counts the questions asked, so an answer that a later question has overtaken is dropped.
  const asked = useRef(0)
  const reposKey = repos.join('|')

  async function check() {
    const turn = ++asked.current
    setChecking(true)
    setError(null)
    try {
      const next = await api.agentChecks()
      if (turn === asked.current) onChecks(next)
    } catch (caught) {
      if (turn === asked.current) setError(caught instanceof Error ? caught.message : 'Could not check the agent providers')
    } finally {
      if (turn === asked.current) setChecking(false)
    }
  }

  // Asks once for each set of repositories. Leaving cancels the answer still on its way.
  useEffect(() => {
    void check()
    return () => {
      asked.current++
    }
  }, [reposKey])

  /** Saves a choice, which the snapshot brings back at once. `wait` holds the card until the providers have been asked again. */
  async function save(change: () => Promise<Snapshot>, wait = false) {
    setBusy(true)
    setError(null)
    try {
      onSnapshot(await change())
      // A new folder or environment is something T3 Code has not been asked about yet.
      const again = check()
      if (wait) await again
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save agent settings')
    } finally {
      setBusy(false)
    }
  }

  const rows = rowsOf(repos, routing, checks)
  const usesT3 = (row: Row) => (row.provider ?? routing.defaultProvider) === 't3'
  const running = checks?.t3Origin ?? null
  const pairing = pairingOf(checks, t3Origin)
  const flagged = pairingFlagged(pairing, pairPrompt)
  const fallback = routing.defaultEnvironmentId ?? null
  const environments = checks?.t3.environments ?? []
  const remote = startsRemotely(rows, routing)
  const unconnected = checks !== null && remote && !checks.t3.connectedUntil
  // Before T3 Code has said what it is linked to, an environment already chosen somewhere shows there are some.
  const choosing = environments.length > 0 || (checks === null && (fallback !== null || rows.some((row) => row.environmentId !== null)))

  return (
    <section className="panel agent-settings" id="settings-agents">
      <header className="panel-head">
        <h2>Agents</h2>
        <span className="panel-note">Where an agent runs when you start one from a pull request</span>
        <button type="button" className="icon-btn" aria-label="Check again" title="Check again" disabled={checking} onClick={() => void check()}>
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
              aria-pressed={routing.defaultProvider === provider.id}
              disabled={busy}
              onClick={() => void save(() => api.setDefaultAgent(provider.id))}
            >
              {provider.label}
            </button>
          ))}
        </div>
      </div>
      {AGENT_PROVIDERS.map(({ id }) => {
        const health = checks?.providers.find((provider) => provider.id === id)?.health ?? null
        return (
          <div
            key={id}
            className="agent-provider"
            data-state={health?.state ?? 'checking'}
            data-flagged={id === 't3' && (flagged || unconnected) ? '' : undefined}
          >
            <div className="agent-health">
              <i className="agent-health-dot" aria-hidden="true" />
              <span className="agent-health-name">
                {providerLabel(id)}
                {health?.detail && health.state === 'ready' ? <span className="panel-note">{health.detail}</span> : null}
              </span>
              <span className="agent-health-state">{health ? healthLabel(health) : 'Checking…'}</span>
            </div>
            {health?.detail && health.state !== 'ready' ? <p className="agent-provider-line panel-note">{health.detail}</p> : null}
            {id === 't3' ? (
              <T3Pairing running={running} unknown={checks === null} paired={t3Origin} pairing={pairing} flagged={flagged} onPaired={onT3Origin} />
            ) : null}
            {id === 't3' && (choosing || fallback) ? (
              <T3Environments
                t3={{ connectedUntil: checks?.t3.connectedUntil ?? null, environments, defaultEnvironmentId: fallback }}
                unknown={checks === null}
                running={running}
                needed={remote}
                busy={busy}
                onDefault={(environmentId) => void save(() => api.setDefaultEnvironment(environmentId))}
                onDisconnect={() => void save(() => api.disconnectT3(), true)}
                onCheck={() => void check()}
              />
            ) : null}
          </div>
        )
      })}
      {error ? <p className="panel-row repo-error">{error}</p> : null}
      {rows.length > 0 ? (
        <>
          <div className="panel-row agent-repos-head">
            <h3>Repositories</h3>
            <span className="panel-note">Override defaults per repo</span>
          </div>
          <div className="agent-cols" aria-hidden="true" data-environments={choosing ? '' : undefined}>
            <span>Repository</span>
            <span>Agent</span>
            {choosing ? <span>Runs on</span> : null}
            <span>T3 Code folder</span>
          </div>
          <ul className="agent-repos" aria-label="Agent provider for each repository" data-environments={choosing ? '' : undefined}>
            {rows.map((row) => (
              <RepoRow
                key={row.repo}
                row={row}
                needsCheckout={usesT3(row)}
                environments={environments}
                choosing={choosing}
                unknown={checks === null}
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
  unknown,
  running,
  needed,
  busy,
  onDefault,
  onDisconnect,
  onCheck,
}: {
  t3: T3Setup
  /** T3 Code has not answered yet, so what it is linked to and whether PR Dash is signed in are not known. */
  unknown: boolean
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
  const stopped = running || unknown ? undefined : 'T3 Code is not running on this machine'
  return (
    <>
      <div className="agent-provider-line">
        <span>Start threads on</span>
        <select
          className="select"
          aria-label="Where T3 Code threads start"
          value={t3.defaultEnvironmentId ?? ''}
          disabled={busy || unknown}
          onChange={(event) => onDefault(event.target.value || null)}
        >
          <option value="">This machine</option>
          {t3.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environmentOption(environment)}
            </option>
          ))}
          {t3.defaultEnvironmentId && !chosen ? (
            <option value={t3.defaultEnvironmentId}>{unknown ? 'Checking…' : 'An environment that is no longer linked'}</option>
          ) : null}
        </select>
      </div>
      {chosen && !chosen.reachable && chosen.detail ? <p className="agent-provider-line agent-problem">{chosen.detail}</p> : null}
      <div className="agent-provider-line">
        <span
          className="agent-connection"
          data-state={connected ? 'connected' : 'unconnected'}
          data-flagged={needed && !connected && !unknown ? '' : undefined}
          title="PR Dash signs in to T3 Code on this machine to start threads on a linked environment. T3 Code asks again about once a month."
        >
          {t3.connectedUntil
            ? `Connected to T3 Code until ${new Date(t3.connectedUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
            : unknown
              ? 'Checking…'
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
  unknown,
  paired,
  pairing,
  flagged,
  onPaired,
}: {
  running: string | null
  /** T3 Code has not been asked yet, so `running` being null does not mean it is stopped. */
  unknown: boolean
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

  const stopped = running || unknown ? undefined : 'T3 Code is not running on this machine'
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
  choosing,
  unknown,
  fallback,
  busy,
  onSave,
}: {
  row: Row
  /** This repository's agents start in T3 Code, which needs a folder to work in. */
  needsCheckout: boolean
  /** The environments T3 Code is linked to. With none, every thread starts on this machine and there is nothing to choose. */
  environments: T3Environment[]
  /** Whether each repository says where its threads start. */
  choosing: boolean
  /** T3 Code has not said yet what it is linked to. */
  unknown: boolean
  /** Where threads start when this repository does not say. Null is this machine. */
  fallback: string | null
  busy: boolean
  onSave: (agent: RepoAgentChange) => Promise<void>
}) {
  const environmentId = environmentFor(fallback, row.environmentId)
  const environment = environments.find((item) => item.id === environmentId)
  const project = row.check?.project ?? null
  // The folder in use: the one set here, or else the folder of T3 Code's own project.
  const current = row.checkout ?? project?.folder ?? ''
  // T3 Code has not said yet which project it has for this repository.
  const waiting = (
    <span className="agent-folder" aria-busy="true">
      <i className="sk" style={{ width: '60%' }} />
    </span>
  )
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
    const next = typed && typed !== project?.folder ? typed : null
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
      {needsCheckout && choosing ? (
        <select
          className="select"
          aria-label={`Where T3 Code threads start for ${row.repo}`}
          value={row.environmentId ?? ''}
          disabled={busy || unknown}
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
            <option value={row.environmentId}>{unknown ? 'Checking…' : 'No longer linked'}</option>
          ) : null}
        </select>
      ) : null}
      {!needsCheckout ? null : environmentId ? (
        // Another environment works in its own project for the repository. There is no folder to set from here.
        <>
          {project ? (
            <span className="agent-folder" title={project.folder}>
              <bdi>{project.folder}</bdi>
            </span>
          ) : !row.check ? (
            waiting
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
          ) : !row.check ? (
            waiting
          ) : (
            <span className="agent-folder" data-missing="" title="Add this repository’s folder as a project in T3 Code, or set the folder here.">
              No T3 Code project
            </span>
          )}
          <span className="agent-folder-actions">
            {current || row.check ? (
              <button type="button" className="text-btn" disabled={busy} onClick={() => setEditing(true)}>
                {current ? 'Change' : 'Set folder'}
              </button>
            ) : null}
            {row.checkout && project ? (
              <button
                type="button"
                className="text-btn"
                disabled={busy}
                title={`Back to T3 Code’s project folder, ${project.folder}`}
                onClick={() => void onSave({ provider: row.provider, checkout: null })}
              >
                Reset
              </button>
            ) : null}
          </span>
        </>
      )}
      {needsCheckout && row.check?.checkoutProblem && !editing ? <p className="agent-problem">{row.check.checkoutProblem}</p> : null}
    </li>
  )
}
