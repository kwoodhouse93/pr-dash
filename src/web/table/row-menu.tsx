import { useContext, useState } from 'react'
import { activeSession, type AgentRequest, failingChecks, PROMPT_LIMIT, providerLabel } from '../../shared/agents.ts'
import { unapprovedMergeBlock } from '../../shared/merge.ts'
import { downstackKeys, type Parents } from '../../shared/stacks.ts'
import type { PullRequest } from '../../shared/types.ts'
import { launchTag, useAgentLaunch, useAgentName } from '../agent-launch.tsx'
import { reviewChase } from '../chase.ts'
import { TagEditor } from '../editors.tsx'
import { copyPrIdsLabel, prCopyList } from '../format.ts'
import { LinkIssueForm } from '../issue-controls.tsx'
import { ClickCard, MenuItem, PopBody, PopFoot, PopHead, useMenuClose } from '../menus.tsx'
import { copyPlain, copyRich } from './clipboard.ts'
import { UnapprovedMergeContext, useStackLock, useTable } from './context.tsx'

/** Every pull request in the stack, bottom first. */
function stackTargets(stackKeys: string[], parents: Parents, prByKey: Map<string, PullRequest>): PullRequest[] {
  return stackKeys
    .map((key, index) => ({ pr: prByKey.get(key), depth: downstackKeys(parents, key).length, index }))
    .filter((item): item is { pr: PullRequest; depth: number; index: number } => item.pr != null)
    .sort((a, b) => a.depth - b.depth || b.index - a.index)
    .map((item) => item.pr)
}

/** The chosen pull request and each one below it, closest to the trunk first. */
function downstackTargets(
  parents: Parents,
  primaryKey: string,
  prByKey: Map<string, PullRequest>,
  shown: PullRequest[],
): PullRequest[] {
  const chain = downstackKeys(parents, primaryKey)
    .reverse()
    .flatMap((key) => {
      const pr = prByKey.get(key)
      return pr ? [pr] : []
    })
  return chain.length ? chain : shown.filter((pr) => pr.key === primaryKey)
}

type RowMenuProps = {
  id: string
  primaryKey: string
  /** Pull requests shown on this row. */
  prs: PullRequest[]
  stackKeys: string[]
  parents: Parents
  defaultWholeStack: boolean
  /** The row's pull request is already in the merge queue. */
  queued?: boolean
}

export function RowMenu(props: RowMenuProps) {
  const { locked } = useStackLock()
  return (
    <td className="row-actions">
      <ClickCard
        id={props.id}
        className="row-menu"
        align="end"
        disabled={locked}
        label={
          <>
            <span className="sr">Row actions</span>
            <span aria-hidden="true">⋯</span>
          </>
        }
      >
        <RowMenuBody {...props} />
      </ClickCard>
    </td>
  )
}

function RowMenuBody(props: RowMenuProps) {
  const [view, setView] = useState<'menu' | 'initiative' | 'prompt' | 'issue'>('menu')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Kept here so a prompt survives a step back to the menu.
  const [prompt, setPrompt] = useState('')
  const close = useMenuClose()
  const agents = useAgentLaunch()
  const mergeUnapproved = useContext(UnapprovedMergeContext)
  const { initiatives, prByKey, linearConfigured, onAssign, onCreateAssigned, onRefreshPr, onLinkIssue } = useTable()
  const pr = prByKey.get(props.primaryKey)
  const unapproved = mergeUnapproved && pr && !props.defaultWholeStack && !props.queued && unapprovedMergeBlock(pr) === null ? pr : null
  const name = useAgentName(pr?.repo ?? props.prs[0]?.repo ?? null)
  const promptTargets = props.prs.length ? props.prs : pr ? [pr] : []
  const failing = props.prs.filter((item) => failingChecks(item).length > 0)
  const copyTargets = downstackTargets(props.parents, props.primaryKey, prByKey, props.prs)
  const stack = props.stackKeys.length > 1 ? stackTargets(props.stackKeys, props.parents, prByKey) : []
  const chases = [
    ...(pr && !props.defaultWholeStack ? [{ label: `Copy review chase for #${pr.number}`, scope: 'this PR', prs: [pr] }] : []),
    ...(stack.length > 1 ? [{ label: 'Copy review chase for stack', scope: 'stack', prs: stack }] : []),
  ]
  const back = () => setView('menu')

  if (view === 'initiative') {
    return (
      <TagEditor
        primaryKey={props.primaryKey}
        stackKeys={props.stackKeys}
        defaultWholeStack={props.defaultWholeStack}
        prByKey={prByKey}
        initiatives={initiatives}
        onAssign={onAssign}
        onCreate={onCreateAssigned}
        onBack={back}
      />
    )
  }
  if (view === 'prompt') {
    return <AgentPromptForm prs={promptTargets} initialKey={props.primaryKey} text={prompt} onText={setPrompt} onStarted={close} onBack={back} />
  }
  if (view === 'issue') {
    return <LinkIssueForm prs={promptTargets} initialKey={props.primaryKey} onLink={onLinkIssue} onBack={back} />
  }

  // The head says which row this is, so the lines under it need not repeat it.
  const single = pr && !props.defaultWholeStack ? pr : null
  const depth = props.stackKeys.length
  const place = single && depth > 1 ? `${depth - props.stackKeys.indexOf(single.key)} of ${depth} in stack` : null
  const title = single ? `#${single.number} · ${single.title}` : `Stack of ${depth}`
  const sub = single
    ? [single.repoName, place].filter(Boolean).join(' · ')
    : [props.prs[0]?.repoName, props.prs.map((item) => `#${item.number}`).join(', ')].filter(Boolean).join(' · ')
  const tagged = single ? initiatives.filter((initiative) => single.initiativeIds.includes(initiative.id)).map((initiative) => initiative.name) : []

  return (
    <>
      <PopHead title={title} sub={sub} />
      <PopBody list>
        {pr ? (
          <MenuItem
            icon="refresh"
            label={pending && !confirming ? 'Refreshing…' : single ? 'Refresh' : `Refresh #${pr.number}`}
            name={`Refresh #${pr.number}`}
            hotkey="r"
            disabled={pending}
            onClick={() => {
              setPending(true)
              setError(null)
              void onRefreshPr(props.primaryKey)
                .then(() => close())
                .catch((caught: unknown) => {
                  setError(caught instanceof Error ? caught.message : 'Could not refresh that pull request')
                })
                .finally(() => setPending(false))
            }}
          />
        ) : null}
        {copyTargets.length || chases.length ? <p className="menu-group">Copy</p> : null}
        {copyTargets.length ? (
          <MenuItem
            icon="copy"
            label={copyTargets.length === 1 ? 'PR ID' : `${copyTargets.length} PR IDs`}
            name={copyPrIdsLabel(copyTargets.length)}
            right={copyTargets.length > 1 ? 'this and below' : undefined}
            hotkey="c"
            onClick={() => {
              const text = prCopyList(copyTargets)
              const confirmation = copyTargets.length === 1 ? `Copied ${text}` : `Copied ${copyTargets.length} PR IDs`
              void copyPlain(text, confirmation).then((copied) => {
                if (copied) close()
              })
            }}
          />
        ) : null}
        {chases.map((chase) => {
          const message = reviewChase(chase.prs)
          return (
            <MenuItem
              key={chase.label}
              icon="chat"
              label="Review chase"
              name={chase.label}
              right={message ? chase.scope : `${chase.scope} · nothing to review`}
              disabled={!message}
              title={message ? undefined : 'Nothing left to review'}
              onClick={() => {
                if (!message) return
                void copyRich(message, 'Copied review chase').then((copied) => {
                  if (copied) close()
                })
              }}
            />
          )
        })}
        {promptTargets.length ? (
          <>
            <p className="menu-group">{name}</p>
            <MenuItem
              icon="spark"
              label={promptTargets.length > 1 ? 'Work on a pull request…' : 'Work on this…'}
              right={prompt.trim() ? 'draft' : undefined}
              name={`Work on ${promptTargets.length > 1 ? 'a pull request' : `#${promptTargets[0]!.number}`} with ${name}…`}
              hotkey="w"
              opens
              onClick={() => setView('prompt')}
            />
          </>
        ) : null}
        {failing.map((item) => {
          const request: AgentRequest = { kind: 'ci' }
          const running = activeSession(item, 'ci')
          const starting = agents.pending === launchTag(item.key, request)
          return (
            <MenuItem
              key={item.key}
              icon="alert"
              tone="alert"
              label={starting ? `Starting ${name}…` : running ? `${providerLabel(running.provider)} is investigating CI` : 'Investigate CI failure'}
              name={
                starting
                  ? `Starting ${name}…`
                  : running
                    ? `${providerLabel(running.provider)} is investigating CI on #${item.number}`
                    : `Investigate CI failure on #${item.number}`
              }
              right={single ? undefined : `#${item.number}`}
              disabled={running !== null || agents.pending !== null}
              onClick={() => {
                void agents.launch(item, request).then((opened) => {
                  if (opened) close()
                })
              }}
            />
          )
        })}
        <p className="menu-group">Organise</p>
        {linearConfigured && promptTargets.length ? (
          <MenuItem icon="link" label="Link Linear issue…" hotkey="l" opens onClick={() => setView('issue')} />
        ) : null}
        <MenuItem icon="tag" label="Initiative…" name="Set initiative" right={tagged.join(', ') || undefined} hotkey="i" opens onClick={() => setView('initiative')} />
        {unapproved && mergeUnapproved ? (
          <>
            <div className="menu-rule" />
            {confirming ? (
              <div className="menu-confirm" role="group" aria-label={`Merge #${unapproved.number} without approval`}>
                <h4>Merge #{unapproved.number} without approval?</h4>
                <p>It joins the merge queue without its required approval. Checks, threads and conflicts still have to be clear.</p>
                <div>
                  <button type="button" className="ghost" autoFocus disabled={pending} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={pending}
                    onClick={() => {
                      setPending(true)
                      setError(null)
                      void mergeUnapproved(unapproved.key)
                        .then(() => close())
                        .catch((caught: unknown) => {
                          setError(caught instanceof Error ? caught.message : 'Could not queue that merge')
                        })
                        .finally(() => {
                          setPending(false)
                          setConfirming(false)
                        })
                    }}
                  >
                    {pending ? 'Queuing…' : 'Merge without approval'}
                  </button>
                </div>
              </div>
            ) : (
              <MenuItem
                icon="merge"
                tone="warn"
                label="Merge without approval…"
                name={`Merge #${unapproved.number} without approval…`}
                disabled={pending}
                onClick={() => setConfirming(true)}
              />
            )}
          </>
        ) : null}
        {error ? <p className="launch-error">{error}</p> : null}
        {agents.error ? <p className="launch-error">{agents.error}</p> : null}
      </PopBody>
    </>
  )
}

function AgentPromptForm({
  prs,
  initialKey,
  text,
  onText,
  onStarted,
  onBack,
}: {
  prs: PullRequest[]
  initialKey: string
  text: string
  onText: (text: string) => void
  onStarted: () => void
  onBack: () => void
}) {
  const [key, setKey] = useState(prs.some((pr) => pr.key === initialKey) ? initialKey : prs[0]!.key)
  const { launch, pending, error } = useAgentLaunch()
  const pr = prs.find((item) => item.key === key) ?? prs[0]!
  const name = useAgentName(pr.repo)
  const busy = pending !== null
  const ready = text.trim().length > 0 && text.length <= PROMPT_LIMIT
  return (
    <form
      className="agent-form pop-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        void launch(pr, { kind: 'prompt', prompt: text }).then((opened) => {
          if (opened) onStarted()
        })
      }}
    >
      <PopHead title={`Work on #${pr.number} with ${name}`} sub="Gets the pull request, its branches and linked issues" onBack={onBack} />
      <PopBody>
        {prs.length > 1 ? (
          <label className="agent-target">
            Pull request
            <select className="select" value={key} disabled={busy} onChange={(event) => setKey(event.target.value)}>
              {prs.map((item) => (
                <option key={item.key} value={item.key}>
                  #{item.number} {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <textarea
          aria-label={`Prompt for ${name}`}
          placeholder={`What should ${name} do? It pushes to the existing branch.`}
          rows={5}
          autoFocus
          value={text}
          disabled={busy}
          maxLength={PROMPT_LIMIT}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        {error ? <p className="launch-error">{error}</p> : null}
      </PopBody>
      <PopFoot hint={<><kbd>⌘↵</kbd> to start</>}>
        <button type="submit" className="primary" disabled={!ready || busy}>
          {busy ? `Starting ${name}…` : 'Start agent'}
        </button>
      </PopFoot>
    </form>
  )
}
