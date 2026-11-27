// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { agentsSummary } from '../src/shared/agents.ts'
import type { AgentSession, PullRequest } from '../src/shared/types.ts'
import { agentItems, AgentsPage } from '../src/web/agents.tsx'
import { loadPreferences, locationSearch, withLocation } from '../src/web/prefs.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function session(patch: Partial<AgentSession>): AgentSession {
  return {
    agentId: 'bc-1',
    provider: 'cursor',
    environmentId: null,
    url: null,
    unreachableSince: null,
    runId: 'run-1',
    kind: 'ci',
    prompt: null,
    status: 'running',
    result: null,
    branch: null,
    createdAt: '2026-10-20T12:00:00Z',
    updatedAt: '2026-10-20T12:00:00Z',
    ...patch,
  }
}

function pull(number: number, agentSessions: AgentSession[]): PullRequest {
  return { key: `acme/app#${number}`, number, title: `Pull ${number}`, url: `https://github.com/acme/app/pull/${number}`, agentSessions } as PullRequest
}

describe('agents summary', () => {
  it('counts the agents at work and the ones waiting for an answer', () => {
    expect(agentsSummary(['creating', 'running', 'waiting', 'finished', 'failed'])).toEqual({ running: 2, waiting: 1, label: 'Agents: 2 running, 1 waiting for you' })
    expect(agentsSummary(['finished'])).toEqual({ running: 0, waiting: 0, label: 'Agents' })
  })
})

describe('agents page', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function show(prs: PullRequest[]) {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    act(() => root!.render(<AgentsPage items={agentItems(prs)} />))
    return host
  }

  it('lists a pull request found in both lists once, newest first', () => {
    const first = pull(1, [session({ agentId: 'a', createdAt: '2026-10-20T12:00:00Z' })])
    const second = pull(2, [session({ agentId: 'b', createdAt: '2026-10-21T12:00:00Z' })])
    expect(agentItems([first, second, first]).map((item) => item.session.agentId)).toEqual(['b', 'a'])
  })

  it('puts the agents that wait for an answer above the ones at work, and the rest below', () => {
    const host = show([
      pull(1, [session({ agentId: 'done', status: 'finished' }), session({ agentId: 'busy', status: 'running' })]),
      pull(2, [session({ agentId: 'asks', status: 'waiting' }), session({ agentId: 'broke', status: 'failed' })]),
    ])
    expect([...host.querySelectorAll('h2')].map((head) => head.textContent)).toEqual(['Waiting for you1', 'Running1', 'Failed1', 'Finished1'])
    expect(host.querySelector('.agent-title')?.textContent).toContain('#2')
  })

  it('opens a line to its prompt and its pull request', () => {
    const host = show([pull(4, [session({ kind: 'prompt', prompt: 'Tidy the imports' })])])
    expect(host.querySelector('.agent-detail')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.agent-row')!.click())
    expect(host.querySelector('.agent-prompt')?.textContent).toBe('Tidy the imports')
    expect(host.querySelector<HTMLAnchorElement>('.agent-detail a')?.textContent).toBe('#4 Pull 4')
  })

  it('says how to start one when there are none', () => {
    expect(show([pull(1, [])]).querySelector('h2')?.textContent).toBe('No agents yet')
  })

  it('has an address of its own', () => {
    const opened = withLocation(loadPreferences(), '?view=agents')
    expect(opened.page).toBe('agents')
    expect(locationSearch(opened)).toBe('?view=agents')
  })
})
