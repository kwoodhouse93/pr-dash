// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStartingSession, sessionLinks, startingAgent, startingSession, startingTabUrl, withStartingSessions } from '../src/shared/agents.ts'
import type { AgentSession } from '../src/shared/types.ts'
import { AgentProvider, useAgentLaunch } from '../src/web/agent-launch.tsx'
import { flyParcel, markCaught, shownBox } from '../src/web/flight.ts'

vi.mock('../src/web/toasts.tsx', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))
const sounds = vi.hoisted(() => ({ whoosh: vi.fn(), landed: vi.fn() }))
vi.mock('../src/web/sounds.ts', () => sounds)

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** An animation that is over as soon as it is asked for. */
function instantAnimations() {
  const animate = vi.fn((_frames: unknown, _timing?: unknown) => ({ finished: Promise.resolve() }))
  ;(Element.prototype as { animate?: unknown }).animate = animate
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  return animate
}

function place(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box })
}

afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the address of a tab opened for an agent', () => {
  it('says where on the page the agent was started', () => {
    const url = startingTabUrl('acme/app#7', { kind: 'ci' }, { x: 10.4, y: 20.6, width: 80, height: 24 })
    expect(startingAgent(url)).toEqual({ key: 'acme/app#7', kind: 'ci', prompt: null, from: { x: 10, y: 21, width: 80, height: 24 } })
  })

  it('is read without a place, and with one that is not a box', () => {
    expect(startingAgent(startingTabUrl('acme/app#7', { kind: 'ci' }))?.from).toBeNull()
    const odd = `about:blank#pr-dash-agent=${encodeURIComponent(JSON.stringify({ key: 'acme/app#7', kind: 'ci', from: [1, 'two', 3, 4] }))}`
    expect(startingAgent(odd)).toMatchObject({ key: 'acme/app#7', from: null })
  })
})

describe('a session that stands in for an agent being started', () => {
  it('is creating, says what was asked, and has nowhere to open', () => {
    const session = startingSession({ kind: 'prompt', prompt: ' Tidy the imports ' }, 'cursor', new Date('2026-11-27T10:00:00Z'))
    expect(session).toMatchObject({ provider: 'cursor', kind: 'prompt', prompt: 'Tidy the imports', status: 'creating', createdAt: '2026-11-27T10:00:00.000Z' })
    expect(isStartingSession(session)).toBe(true)
    expect(sessionLinks(session)).toEqual({ webUrl: null, appUrl: null })
    expect(startingSession({ kind: 'ci' }, 't3').agentId).not.toBe(session.agentId)
  })

  it('is put on its own pull request, ahead of the sessions that one has', () => {
    const real = { agentId: 'bc-1' } as AgentSession
    const session = startingSession({ kind: 'ci' }, 't3')
    const prs = [
      { key: 'acme/app#1', agentSessions: [real] },
      { key: 'acme/app#2', agentSessions: [] },
    ]
    const shown = withStartingSessions(prs, [{ key: 'acme/app#1', session }])
    expect(shown[0]!.agentSessions).toEqual([session, real])
    expect(shown[1]).toBe(prs[1])
    expect(withStartingSessions(prs, [])).toBe(prs)
    expect(isStartingSession(real)).toBe(false)
  })
})

describe('the flight of a task', () => {
  const from = { x: 300, y: 200, width: 80, height: 24 }

  it('is not played with reduced motion', async () => {
    instantAnimations()
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    expect(await flyParcel({ layer: document.body, from, label: 'CI failure', to: () => from })).toBe(false)
    expect(document.body.children.length).toBe(0)
  })

  it('folds up where it was started, lands, and leaves nothing behind', async () => {
    const animate = instantAnimations()
    const to = vi.fn(() => ({ x: 20, y: 60, width: 10, height: 10 }))
    const takeoff = vi.fn()
    const flying = flyParcel({ layer: document.body, from, label: 'CI failure', to, onTakeoff: takeoff })
    const parcel = document.body.firstElementChild as HTMLElement
    expect(parcel.textContent).toBe('CI failure')
    expect([parcel.style.left, parcel.style.top, parcel.style.width]).toEqual(['300px', '200px', '80px'])
    expect(await flying).toBe(true)
    expect(to).toHaveBeenCalledTimes(1)
    expect(takeoff).toHaveBeenCalledTimes(1)
    // The last flight ends at the middle of the target, measured from the middle of the start.
    const frames = animate.mock.calls.at(-1)![0] as { transform: string }[]
    expect(frames.at(-1)!.transform).toContain('translate(-315px, -147px)')
    // It swoops: on the way it is well off the straight line, to the upper side of it.
    const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(frames[Math.round(frames.length * 0.6)]!.transform)!.map(Number)
    expect(y! - (x! * -147) / -315).toBeLessThan(-40)
    expect(document.body.children.length).toBe(0)
  })

  it('fades where it is with nowhere to land', async () => {
    instantAnimations()
    expect(await flyParcel({ layer: document.body, from, label: 'Prompt', to: () => null })).toBe(false)
    expect(document.body.children.length).toBe(0)
  })

  it('does not take a hidden element for a place to land', () => {
    const hidden = document.body.appendChild(document.createElement('div'))
    place(hidden, { x: 0, y: 0, width: 0, height: 0 })
    expect(shownBox(hidden)).toBeNull()
    expect(shownBox(null)).toBeNull()
  })

  it('marks what caught it for a moment', () => {
    vi.useFakeTimers()
    const button = document.body.appendChild(document.createElement('button'))
    markCaught(button)
    expect(button.classList.contains('caught')).toBe(true)
    vi.advanceTimersByTime(600)
    expect(button.classList.contains('caught')).toBe(false)
    vi.useRealTimers()
  })
})

describe('starting an agent', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    delete (window as { prDashDesktop?: boolean }).prDashDesktop
  })

  function Launcher() {
    const { launch } = useAgentLaunch()
    return (
      <>
        <button type="button" className="tool-btn agents-tool" />
        <button type="button" className="start" onClick={() => void launch({ key: 'acme/web#7' }, { kind: 'ci' })}>
          Fix
        </button>
      </>
    )
  }

  async function show(start: () => Promise<{ url: string | null }>, t3Origin: string | null = null) {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () =>
      root!.render(
        <AgentProvider start={start} routing={{ defaultProvider: 't3', repos: {} }} t3Origin={t3Origin}>
          <Launcher />
        </AgentProvider>,
      ),
    )
    const button = host.querySelector('.start') as HTMLElement
    const tool = host.querySelector('.agents-tool') as HTMLElement
    place(button, { x: 300, y: 200, width: 80, height: 24 })
    place(tool, { x: 600, y: 10, width: 34, height: 34 })
    return { button, tool }
  }

  it('flies the task to the agents button, with a rush on the way and a note as it lands', async () => {
    instantAnimations()
    sounds.whoosh.mockClear()
    sounds.landed.mockClear()
    const { button, tool } = await show(async () => ({ url: null }))
    await act(async () => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      button.click()
    })
    expect(sounds.whoosh).toHaveBeenCalledTimes(1)
    expect(sounds.whoosh.mock.calls[0]![0]).toBeGreaterThan(0)
    expect(sounds.landed).toHaveBeenCalledTimes(1)
    expect(tool.classList.contains('caught')).toBe(true)
  })

  it('in the desktop app, tells the window where the task was started and flies to where the window lists it', async () => {
    const animate = instantAnimations()
    ;(window as { prDashDesktop?: boolean }).prDashDesktop = true
    const tab = { location: { replace: vi.fn() }, close: vi.fn(), opener: null }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const { button, tool } = await show(async () => ({ url: 'http://127.0.0.1:3773/threads/abc' }), 'http://127.0.0.1:3773')
    await act(async () => {
      button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      button.click()
    })
    expect(startingAgent(String(open.mock.calls[0]![0]))).toMatchObject({ key: 'acme/web#7', kind: 'ci', from: { x: 300, y: 200, width: 80, height: 24 } })
    // Nothing is played until the window says where the task lands, and then this page plays its part.
    expect(animate).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('pr-dash:flight', { detail: { to: { x: -200, y: 40, width: 10, height: 10 }, at: Date.now() } }))
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    const frames = animate.mock.calls.at(-1)![0] as { transform: string }[]
    expect(frames.at(-1)!.transform).toContain('translate(-535px, -167px)')
    expect(document.querySelector('[style*="fixed"]')).toBeNull()
    // The window's own list catches it, not the button on this page.
    expect(tool.classList.contains('caught')).toBe(false)
  })
})
