import { useState } from 'react'
import { activeSession, type AgentRequest } from '../../shared/agents.ts'
import { type Parents, upstackKeys } from '../../shared/stacks.ts'
import type { PullRequest } from '../../shared/types.ts'
import { launchTag, useAgentLaunch, useAgentName } from '../agent-launch.tsx'
import { ClickCard, PopBody, PopFoot, PopHead, useMenuClose } from '../menus.tsx'
import { RunningNote } from './agents-cell.tsx'
import { useStackLock, useTable } from './context.tsx'

export function Conflict({ id, prs }: { id: string; prs: PullRequest[] }) {
  const conflicts = prs.filter((pr) => pr.conflict)
  const { launch, pending, error } = useAgentLaunch()
  const name = useAgentName(prs[0]?.repo ?? null)
  const { locked } = useStackLock()
  const request: AgentRequest = { kind: 'conflict' }
  const idle = conflicts.filter((pr) => !activeSession(pr, 'conflict'))

  if (conflicts.length === 0) {
    return (
      <td className="conflict">
        <span className="sr">No conflict</span>
      </td>
    )
  }

  return (
    <td className="conflict">
      <span className="conflict-cell">
        <ClickCard
          id={id}
          className="conflict-x"
          disabled={locked}
          label={
            <>
              <span className="sr">Resolve merge conflict with {name}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </>
          }
        >
          <PopHead title={conflicts.length === 1 ? `Resolve conflict on #${conflicts[0]!.number}` : 'Resolve conflicts'} />
          <PopBody>
            <p>
              {name} resolves the conflict and pushes to {conflicts.length === 1 ? 'this pull request’s' : 'each pull request’s'} existing branch.
            </p>
            {conflicts.map((pr) => {
              const running = activeSession(pr, 'conflict')
              return running ? <RunningNote key={pr.key} session={running} prefix={conflicts.length > 1 ? `#${pr.number}` : null} /> : null
            })}
            {error ? <p className="launch-error">{error}</p> : null}
          </PopBody>
          {idle.length ? (
            <PopFoot>
              {idle.map((pr) => (
                <button
                  key={pr.key}
                  type="button"
                  className="primary"
                  disabled={locked || pending !== null}
                  aria-busy={pending === launchTag(pr.key, request)}
                  onClick={() => void launch(pr, request)}
                >
                  {pending === launchTag(pr.key, request)
                    ? `Starting ${name}…`
                    : conflicts.length > 1
                      ? `Resolve #${pr.number} with ${name}`
                      : `Resolve with ${name}`}
                </button>
              ))}
            </PopFoot>
          ) : null}
        </ClickCard>
      </span>
    </td>
  )
}

export function UpToDate({
  id,
  targetKey,
  stackKeys,
  parents,
}: {
  id: string
  targetKey: string | null
  stackKeys: string[]
  parents: Parents
}) {
  const { prByKey, onRebase } = useTable()
  const plan = targetKey ? rebasePlan(stackKeys, parents, targetKey, prByKey) : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { locked, lock, unlock } = useStackLock()
  const close = useMenuClose()

  async function rebase(target: PullRequest) {
    if (pending) return
    if (!lock()) return
    setError(null)
    setPending(true)
    try {
      await onRebase(target.key)
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rebase.')
    } finally {
      setPending(false)
      unlock()
    }
  }

  if (!plan) {
    return (
      <td className="uptodate">
        <span className="sr">Up to date</span>
      </td>
    )
  }

  const { target, above } = plan
  return (
    <td className="uptodate">
      <ClickCard
        id={id}
        className="uptodate-x"
        disabled={locked && !pending}
        label={
          <>
            <span className="sr">Not up to date. Rebase onto the base branch</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4 12 12 M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </>
        }
      >
        <PopHead title={`Rebase #${target.number}`} />
        <PopBody>
          <p>{rebaseCopy(target, above)}</p>
          {error ? <p className="launch-error">{error}</p> : null}
        </PopBody>
        <PopFoot>
          <button type="button" className="primary" disabled={pending || locked} onClick={() => void rebase(target)}>
            {pending ? 'Rebasing…' : 'Rebase'}
          </button>
        </PopFoot>
      </ClickCard>
    </td>
  )
}

function rebasePlan(
  stackKeys: string[],
  parents: Parents,
  targetKey: string,
  prByKey: Map<string, PullRequest>,
): { target: PullRequest; above: PullRequest[] } | null {
  const target = prByKey.get(targetKey)
  if (!target) return null
  const above = upstackKeys(stackKeys, parents, targetKey).flatMap((key) => {
    const pr = prByKey.get(key)
    return pr ? [pr] : []
  })
  return { target, above }
}

/** Walks up from the trunk, so the one it finds has nothing behind beneath it. */
export function lowestBehindKey(stackKeys: string[], prs: PullRequest[]): string | null {
  const behind = new Set(prs.filter((pr) => pr.behind).map((pr) => pr.key))
  for (let index = stackKeys.length - 1; index >= 0; index--) {
    const key = stackKeys[index]!
    if (behind.has(key)) return key
  }
  return null
}

function rebaseCopy(target: PullRequest, above: PullRequest[]): string {
  const onto = `the latest commit of ${target.baseRef}`
  if (above.length === 0) return `Rebase #${target.number} onto ${onto}.`
  const names = above.map((pr) => `#${pr.number}`)
  const list =
    names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
  return `Rebase #${target.number} onto ${onto}. ${list} ${above.length === 1 ? 'is' : 'are'} restacked with it.`
}
