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
  api: { agentSettings: vi.fn(), setDefaultAgent: vi.fn(), setRepoAgent: vi.fn(), pairT3: vi.fn() },
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
    t3Origin: 'http://127.0.0.1:3773',
    providers: [
      { id: 'cursor', health: { state: 'unconfigured', detail: 'Set CURSOR_API_KEY on the server to start Cursor agents.' } },
      { id: 't3', health: { state: 'ready', detail: 't3 v0.1.10' } },
    ],
    repos: [
      { repo: 'acme/app', provider: null, project: null, checkout: null, checkoutProblem: null },
      { repo: 'acme/web', provider: 't3', project: null, checkout: '~/code/web', checkoutProblem: 'T3 Code has no project for ~/code/web.' },
      { repo: 'acme/api', provider: 't3', project: { title: 'api', folder: '~/code/api' }, checkout: null, checkoutProblem: null },
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
    const health = [...document.querySelectorAll('.agent-provider')].map((row) => [row.getAttribute('data-state'), row.querySelector('.agent-health')?.textContent])
    expect(health).toEqual([
      ['unconfigured', 'CursorNot set up'],
      ['ready', 'T3 Codet3 v0.1.10Ready'],
    ])
    expect(document.querySelector('.agent-provider p')?.textContent).toBe('Set CURSOR_API_KEY on the server to start Cursor agents.')
    const rows = [...document.querySelectorAll('.agent-repo')]
    // acme/app follows the default, Cursor, so it needs no folder.
    expect(rows[0]?.querySelector('.agent-problem')).toBeNull()
    expect(rows[1]?.querySelector('.agent-problem')?.textContent).toBe('T3 Code has no project for ~/code/web.')
    expect(rows[0]?.querySelector('.agent-folder')).toBeNull()
    // acme/web has a folder set here, which can be put back only to a T3 Code project it does not have.
    expect(rows[1]?.querySelector('.agent-folder')?.hasAttribute('data-set')).toBe(true)
    expect([...(rows[1]?.querySelectorAll('button') ?? [])].map((button) => button.textContent)).toEqual(['Change'])
    // acme/api has a T3 Code project, so it shows that and asks for nothing.
    expect(rows[2]?.querySelector('.agent-folder')?.textContent).toBe('~/code/api')
    expect(rows[2]?.querySelector('input')).toBeNull()
    expect(rows[2]?.querySelector('.agent-problem')).toBeNull()
  })

  const button = (within: ParentNode | null | undefined, label: string) => [...(within?.querySelectorAll('button') ?? [])].find((found) => found.textContent === label) as HTMLElement
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('changes a folder starting from the one in use, and cancels without saving', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    vi.mocked(api.setRepoAgent).mockResolvedValue({ settings: settings(), snapshot: {} as Snapshot })
    await render(<AgentSettingsPanel repos={['acme/api']} onSnapshot={() => {}} />)
    const row = document.querySelectorAll('.agent-repo')[2]
    await act(async () => button(row, 'Change').click())
    const input = row?.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('~/code/api')
    await act(async () => type(input, '~/elsewhere'))
    await act(async () => button(row, 'Cancel').click())
    expect(row?.querySelector('input')).toBeNull()
    expect(row?.querySelector('.agent-folder')?.textContent).toBe('~/code/api')
    expect(api.setRepoAgent).not.toHaveBeenCalled()

    await act(async () => button(row, 'Change').click())
    await act(async () => type(row?.querySelector('input') as HTMLInputElement, ' ~/elsewhere '))
    await act(async () => button(row, 'Save').click())
    expect(api.setRepoAgent).toHaveBeenCalledWith('acme/api', { provider: 't3', checkout: '~/elsewhere' })
  })

  it('resets a folder set here to the folder of the T3 Code project', async () => {
    const overridden = settings({ repos: [{ repo: 'acme/api', provider: 't3', project: { title: 'api', folder: '~/code/api' }, checkout: '~/elsewhere', checkoutProblem: null }] })
    vi.mocked(api.agentSettings).mockResolvedValue(overridden)
    vi.mocked(api.setRepoAgent).mockResolvedValue({ settings: settings(), snapshot: {} as Snapshot })
    await render(<AgentSettingsPanel repos={['acme/api']} onSnapshot={() => {}} />)
    expect(document.querySelector('.agent-folder')?.textContent).toBe('~/elsewhere')
    await act(async () => button(document, 'Reset').click())
    expect(api.setRepoAgent).toHaveBeenCalledWith('acme/api', { provider: 't3', checkout: null })
  })

  it('flags T3 Code when this browser is not paired, unless the user chose not to be asked', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    const t3 = () => document.querySelectorAll('.agent-provider')[1]
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} />)
    expect(t3()?.hasAttribute('data-flagged')).toBe(true)
    expect(t3()?.querySelector('.agent-pairing')?.textContent).toBe('Not paired')
    act(() => root?.unmount())
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} pairPrompt={false} />)
    expect(t3()?.hasAttribute('data-flagged')).toBe(false)
    act(() => root?.unmount())
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} t3Origin="http://127.0.0.1:3773" />)
    expect(t3()?.hasAttribute('data-flagged')).toBe(false)
    act(() => root?.unmount())
    // T3 Code now answers somewhere else, so the pairing is flagged even when not asking to pair.
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} t3Origin="http://127.0.0.1:4000" pairPrompt={false} />)
    expect(t3()?.hasAttribute('data-flagged')).toBe(true)
    expect(t3()?.querySelector('.agent-pairing')?.textContent).toBe('Pairing out of date')
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
    expect(document.querySelector('.agent-repo .agent-folder')?.textContent).toBe('No T3 Code project')
  })

  it('pairs this browser with T3 Code: opens the pairing link in a tab and remembers where T3 Code is', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    vi.mocked(api.pairT3).mockResolvedValue({ pairUrl: 'http://127.0.0.1:3773/pair#token=ABC', origin: 'http://127.0.0.1:3773' })
    const tab = { location: { replace: vi.fn() }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const paired: (string | null)[] = []
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} onT3Origin={(origin) => paired.push(origin)} />)
    const pair = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Pair') as HTMLElement
    await act(async () => pair.click())
    expect(tab.location.replace).toHaveBeenCalledWith('http://127.0.0.1:3773/pair#token=ABC')
    expect(paired).toEqual(['http://127.0.0.1:3773'])
  })

  it('hands the pairing link to the desktop app without opening a tab first', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    vi.mocked(api.pairT3).mockResolvedValue({ pairUrl: 'http://127.0.0.1:3773/pair#token=ABC', origin: 'http://127.0.0.1:3773' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    ;(window as { prDashDesktop?: boolean }).prDashDesktop = true
    const paired: (string | null)[] = []
    try {
      await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} onT3Origin={(origin) => paired.push(origin)} />)
      await act(async () => ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Pair') as HTMLElement).click())
    } finally {
      delete (window as { prDashDesktop?: boolean }).prDashDesktop
    }
    // One call, with the link itself: the app pairs out of sight and opens nothing.
    expect(open.mock.calls).toEqual([['http://127.0.0.1:3773/pair#token=ABC', '_blank']])
    expect(paired).toEqual(['http://127.0.0.1:3773'])
  })

  it('takes a pairing code by hand when pairing by itself fails', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    vi.mocked(api.pairT3).mockRejectedValue(new Error('Pairing with T3 Code is only offered when the dashboard runs on this machine.'))
    const tab = { location: { replace: vi.fn() }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const paired: (string | null)[] = []
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} onT3Origin={(origin) => paired.push(origin)} />)
    await act(async () => ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Pair') as HTMLElement).click())
    expect(tab.close).toHaveBeenCalled()
    expect(document.querySelector('.repo-error')?.textContent).toMatch(/only offered/)
    expect(paired).toEqual([])
    const input = document.querySelector('input[aria-label="T3 Code pairing code"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' XYZ 1 ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Pair') as HTMLElement).click())
    expect(open).toHaveBeenLastCalledWith('http://127.0.0.1:3773/pair#token=XYZ%201', '_blank')
    expect(paired).toEqual(['http://127.0.0.1:3773'])
  })

  it('says a paired browser is paired, and forgets it when asked', async () => {
    vi.mocked(api.agentSettings).mockResolvedValue(settings())
    const paired: (string | null)[] = []
    await render(<AgentSettingsPanel repos={[]} onSnapshot={() => {}} t3Origin="http://127.0.0.1:3773" onT3Origin={(origin) => paired.push(origin)} />)
    expect(document.body.textContent).toContain('Paired with 127.0.0.1:3773')
    await act(async () => ([...document.querySelectorAll('button')].find((button) => button.textContent === 'Forget') as HTMLElement).click())
    expect(paired).toEqual([null])
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

  it('opens a new T3 Code thread in a tab when this browser is paired with T3 Code', async () => {
    const tab = { document: { open() {}, write() {}, close() {} }, location: { replace: vi.fn() }, opener: null, close() {} }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const start = vi.fn(async () => ({ url: 'https://app.t3.codes/threads/env-1/mcp%3Athread-1' }))
    await render(
      <AgentProvider start={start} routing={{ defaultProvider: 't3', repos: {} }} t3Origin="http://127.0.0.1:3773">
        <Launcher repo="acme/web" />
      </AgentProvider>,
    )
    await act(async () => (document.querySelector('button') as HTMLElement).click())
    expect(tab.location.replace).toHaveBeenCalledWith('http://127.0.0.1:3773/threads/env-1/mcp%3Athread-1')
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
