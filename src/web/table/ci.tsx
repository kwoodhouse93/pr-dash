import { useState } from 'react'
import { activeSession, type AgentRequest, failingChecks } from '../../shared/agents.ts'
import { checkPhase, checkStamp, ciDetail, type CiDisplay, ciLabel, compareChecks, selectChecks } from '../../shared/ci.ts'
import type { Check, PullRequest } from '../../shared/types.ts'
import { launchTag, useAgentLaunch, useAgentName } from '../agent-launch.tsx'
import { ClickCard, PopBody, PopFoot, PopHead } from '../menus.tsx'
import { RunningNote } from './agents-cell.tsx'
import { EMPTY_HOLDS, shownLevel, useHolds, useStackLock, useTable } from './context.tsx'

export function CiControl({ id, prs }: { id: string; prs: PullRequest[] }) {
  const level = shownLevel(prs, useHolds())
  const { locked } = useStackLock()
  return (
    <ClickCard id={id} className={`ci ${level}`} disabled={locked} label={ciLabel(level)}>
      <CiPanel prs={prs} level={level} />
    </ClickCard>
  )
}

function CiPanel({ prs, level }: { prs: PullRequest[]; level: CiDisplay }) {
  const holds = useHolds()
  const invalidated = (pr: PullRequest, check: Check) =>
    (holds.get(pr.key) ?? EMPTY_HOLDS).some((hold) => hold.name === check.name && hold.stamp === checkStamp(check))
  const checks = prs.flatMap((pr) => selectChecks(pr.checks).map((check) => ({ pr, check })))
  checks.sort((a, b) => {
    const rank = Number(invalidated(b.pr, b.check)) - Number(invalidated(a.pr, a.check))
    return rank || compareChecks(a.check, b.check) || a.pr.number - b.pr.number
  })
  const grouped = new Map<string, { pr: PullRequest; check: Check }[]>()
  for (const item of checks) {
    const name = item.check.workflowName ?? 'Other'
    const list = grouped.get(name) ?? []
    list.push(item)
    grouped.set(name, list)
  }
  const heading = prs.length === 1 || level === 'invalidated' ? ciDetail(level) : 'Checks across this stack'
  const tones = checks.map(({ pr, check }) => {
    if (invalidated(pr, check)) return 'pending'
    const phase = checkPhase(check)
    return phase === 'fail' ? 'fail' : phase === 'missing' || phase === 'pending' ? 'pending' : 'success'
  })
  const tally = (
    [
      ['fail', 'failing'],
      ['pending', 'waiting'],
      ['success', 'passed'],
    ] as const
  )
    .map(([tone, word]) => [tones.filter((item) => item === tone).length, word] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(' · ')
  const agents = useAgentLaunch()
  return (
    <>
      <PopHead title={heading} sub={tally || undefined} />
      <PopBody>
      {[...grouped.entries()].map(([workflow, items]) => (
        <div key={workflow} className="check-group">
          <h4>{workflow}</h4>
          {items.map(({ pr, check }) => {
            const phase = checkPhase(check)
            const stale = invalidated(pr, check)
            const tone = stale ? 'invalidated' : phase === 'fail' ? 'fail' : phase === 'missing' || phase === 'pending' ? 'pending' : 'success'
            const state = stale
              ? 'Invalidated'
              : phase === 'fail'
                ? 'Failed'
                : phase === 'missing'
                  ? 'Not reported'
                  : phase === 'pending'
                    ? 'Running'
                    : null
            return (
              <div key={`${pr.id}:${check.name}`} className="check">
                <i className={tone} />
                <span>
                  {prs.length > 1 ? `#${pr.number} ` : ''}
                  {check.url ? (
                    <a className="external" href={check.url} target="_blank" rel="noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </span>
                <span className="req">
                  {state ? <em className={tone}>{state}</em> : null}
                  {state ? ' · ' : ''}
                  {check.required ? 'Required' : 'Optional'}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {checks.length === 0 ? <p>No checks on the latest commit.</p> : null}
      <CiAgentNotes prs={prs} error={agents.error} />
      </PopBody>
      <CiFoot prs={prs} agents={agents} />
    </>
  )
}

/** The foot of the checks popup: run them again on the left, hand a failure to an agent on the right. */
function CiFoot({ prs, agents }: { prs: PullRequest[]; agents: ReturnType<typeof useAgentLaunch> }) {
  const { onRerun } = useTable()
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<'failed' | 'all' | null>(null)
  const name = useAgentName(prs[0]?.repo ?? null)
  const failing = prs.filter((pr) => failingChecks(pr).length > 0)
  const idle = failing.filter((pr) => !activeSession(pr, 'ci'))
  const request: AgentRequest = { kind: 'ci' }
  async function run(mode: 'failed' | 'all') {
    setPending(mode)
    setMessage(null)
    try {
      setMessage(await onRerun(prs.map((pr) => pr.key), mode))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Rerun failed')
    } finally {
      setPending(null)
    }
  }
  return (
    <PopFoot
      hint={
        <>
          <button type="button" className="ghost" disabled={pending !== null} aria-busy={pending === 'failed'} onClick={() => void run('failed')}>
            {pending === 'failed' ? 'Rerunning…' : 'Rerun failed'}
          </button>
          <button type="button" className="ghost" disabled={pending !== null} aria-busy={pending === 'all'} onClick={() => void run('all')}>
            {pending === 'all' ? 'Rerunning…' : 'Rerun all'}
          </button>
        </>
      }
    >
      {idle.map((pr) => (
        <button
          key={pr.key}
          type="button"
          className="primary"
          disabled={agents.pending !== null}
          aria-busy={agents.pending === launchTag(pr.key, request)}
          onClick={() => void agents.launch(pr, request)}
        >
          {agents.pending === launchTag(pr.key, request)
            ? `Starting ${name}…`
            : `Investigate ${failing.length > 1 ? `#${pr.number} ` : ''}with ${name}`}
        </button>
      ))}
      {message ? <p>{message}</p> : null}
    </PopFoot>
  )
}

/** What an agent is doing about a failure, or what it would do. The button that starts one is in the foot. */
function CiAgentNotes({ prs, error }: { prs: PullRequest[]; error: string | null }) {
  const failing = prs.filter((pr) => failingChecks(pr).length > 0)
  const name = useAgentName(prs[0]?.repo ?? null)
  if (failing.length === 0) return null
  const idle = failing.some((pr) => !activeSession(pr, 'ci'))
  return (
    <div className="ci-agent">
      {failing.map((pr) => {
        const running = activeSession(pr, 'ci')
        return running ? <RunningNote key={pr.key} session={running} prefix={failing.length > 1 ? `#${pr.number}` : null} /> : null
      })}
      {idle ? <p>{name} reads the failing logs, pushes a fix if the cause is clear, and reports back if it is not.</p> : null}
      {error ? <p className="launch-error">{error}</p> : null}
    </div>
  )
}
