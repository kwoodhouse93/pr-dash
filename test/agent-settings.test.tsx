// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSettings } from '../src/shared/agents.ts'
import type { Snapshot } from '../src/shared/types.ts'
import { AgentProvider, useAgentLaunch, useAgentName } from '../src/web/agent-launch.tsx'
import { AgentSettingsPanel } from '../src/web/agent-settings.tsx'
import { api } from '../src/web/api.ts'

vi.mock('../src/web/api.ts', () => ({
  api: { agentSettings: vi.fn(), setDefaultAgent: vi.fn(), setRepoAgent: vi.fn() },
}))

const toasts = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))
vi.mock('../src/web/toasts.tsx', () => toasts)

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function settings(patch: Partial<AgentSettings> = {}): AgentSettings {
  return {
    defaultProvider: 'cursor',
    providers: [
      { id: 'cursor', health: { state: 'unconfigured', detail: 'Set CURSOR_API_KEY on the server to start Cursor agents.' } },
      { id: 't3', health: { state: 'ready', detail: 't3 v0.1.10' } },
    ],
    repos: [
      { repo: 'acme/app', provider: null, checkout: null, checkoutProblem: null },
      { repo: 'acme/web', provider: 't3', checkout: '~/code/web', checkoutProblem: 'T3 Code has no project for ~/code/web.' },
    ],
    ...patch,
  }
}

describe('agent settings and launch', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  async function render(node: React.ReactNode) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(node)
    })
  }

  it('shows each provider with its health, and what T3 Code still needs for a repository', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    await render(<AgentSettingsPanel repos={['acme/app', 'acme/web']} onSnapshot={() => {}} />)
    const health = [...document.querySelectorAll('.agent-health')].map((row) => [row.getAttribute('data-state'), row.textContent])
    expect(health).toEqual([
      ['unconfigured', 'CursorNot set upSet CURSOR_API_KEY on the server to start Cursor agents.'],
      ['ready', 'T3 CodeReadyt3 v0.1.10'],
    ])
    const rows = [...document.querySelectorAll('.agent-repo')]
    // acme/app follows the default, Cursor, so it needs no folder.
    expect(rows[0]?.querySelector('.agent-problem')).toBeNull()
    expect(rows[1]?.querySelector('.agent-problem')?.textContent).toBe('T3 Code has no project for ~/code/web.')
  })

  it('saves the default provider, passes the snapshot on, and then asks for the folder T3 Code needs', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    const snapshot = { agents: { defaultProvider: 't3', repos: {} } } as Snapshot
    vi.mocked(api.setDefaultAgent).mockResolvedValue({ settings: settings({ defaultProvider: 't3' }), snapshot })
    const seen: Snapshot[] = []
    await render(<AgentSettingsPanel repos={['acme/app', 'acme/web']} onSnapshot={(snap) => seen.push(snap)} />)
    const t3 = [...document.querySelectorAll('.segmented button')].find((button) => button.textContent === 'T3 Code') as HTMLElement
    await act(async () => t3.click())
    expect(api.setDefaultAgent).toHaveBeenCalledWith('t3')
    expect(seen).toEqual([snapshot])
    expect(t3.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.agent-repo .agent-problem')?.textContent).toMatch(/needs this folder/)
  })

  function Launcher({ repo }: { repo: string }) {
    const { launch, error } = useAgentLaunch()
    const name = useAgentName(repo)
    return (
      <>
        <button type="button" onClick={() => void launch({ key: `${repo}#7` }, { kind: 'ci' })}>
          Investigate with {name}
        </button>
        <p className="error">{error}</p>
      </>
    )
  }

  it('starts a T3 Code agent without opening a tab', async () => {
    const open = vi.spyOn(window, 'open')
    const start = vi.fn(async () => ({ url: 'https://t3.example/thread' }))
    await render(
      <AgentProvider start={start} routing={{ defaultProvider: 'cursor', repos: { 'acme/web': 't3' } }}>
        <Launcher repo="acme/web" />
      </AgentProvider>,
    )
    const button = document.querySelector('button') as HTMLElement
    expect(button.textContent).toBe('Investigate with T3 Code')
    await act(async () => button.click())
    expect(start).toHaveBeenCalledWith('acme/web#7', { kind: 'ci' }, undefined)
    expect(open).not.toHaveBeenCalled()
    expect(toasts.toastSuccess).toHaveBeenCalledWith('Started in T3 Code. Follow it in the Agents column.')
  })

  it('offers another provider when the chosen one is out of reach, and starts there only when asked', async () => {
    const tab = { document: { open() {}, write() {}, close() {} }, location: { replace: vi.fn() }, opener: null, close() {} }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const start = vi.fn(async (_key: string, _request: unknown, provider?: string) => {
      if (!provider) throw Object.assign(new Error('T3 Code is not running on this machine. Start it, then try again.'), { body: { fallback: 'cursor' } })
      return { url: 'https://cursor.com/agents/bc-1' }
    })
    await render(
      <AgentProvider start={start} routing={{ defaultProvider: 't3', repos: {} }}>
        <Launcher repo="acme/app" />
      </AgentProvider>,
    )
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    expect(document.querySelector('.error')?.textContent).toMatch(/not running/)
    expect(start).toHaveBeenCalledTimes(1)
    const offer = toasts.toastError.mock.calls[0]?.[1] as { retryLabel: string; onRetry: () => void }
    expect(offer.retryLabel).toBe('Use Cursor instead')
    await act(async () => offer.onRetry())
    expect(start).toHaveBeenLastCalledWith('acme/app#7', { kind: 'ci' }, 'cursor')
    expect(tab.location.replace).toHaveBeenCalledWith('https://cursor.com/agents/bc-1')
  })
})
