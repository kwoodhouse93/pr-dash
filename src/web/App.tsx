import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { personalBests, type Activity } from '../shared/activity.ts'
import { collectHolds, mergeHolds, reconcileHolds, withoutHolds, type CheckHold } from '../shared/ci.ts'
import { DESKTOP_PAGES, onDesktopEvent } from '../shared/desktop-events.ts'
import type { FeedbackCounts } from '../shared/feedback.ts'
import { ICON_FRAMES, iconState, iconSvg } from '../shared/icon.ts'
import { queueSummary, rowMarks } from '../shared/queue.ts'
import type { QueueSnapshot } from '../shared/queue.ts'
import { themeOf } from '../shared/themes.ts'
import { DEFAULT_FILTERS, type AgentSession, isListName, type Filters, type ListName, type PullRequest, type SortKey } from '../shared/types.ts'
import { type AgentChecks, providerFor, startingSession, withStartingSessions } from '../shared/agents.ts'
import { pullKeyRepo } from '../shared/repos.ts'
import { attentionOf, buildOutline, needsAttention, outlineEmpty, prMatches } from '../shared/view.ts'
import { ActivityPage } from './activity.tsx'
import { api } from './api.ts'
import { ManageInitiatives } from './editors.tsx'
import { FilterBar, activeFilterLabels } from './filter-bar.tsx'
import { MenuProvider } from './menus.tsx'
import { loadPreferences, locationSearch, savePreferences, withLocation, type DashboardPage } from './prefs.ts'
import { PrLinksProvider } from './pr-links.tsx'
import { MergeQueuePage } from './queue.tsx'
import { AgentProvider } from './agent-launch.tsx'
import { agentItems, AgentsPage } from './agents.tsx'
import { SETTINGS_TABS, SettingsPage, settingsAttention } from './settings.tsx'
import { fold, setSoundsEnabled } from './sounds.ts'
import { pressBox, QUEUE_BUTTON, sendOff } from './send-off.ts'
import { applyAnimations } from './animations.ts'
import { applyTheme } from './theme.ts'
import { RepoMarksProvider } from './repo-mark.tsx'
import { Shortcuts } from './shortcuts.tsx'
import { Roll, reducedMotion, useLingering } from './motion.tsx'
import { PrTable, SkeletonTable } from './table.tsx'
import { Toasts, clearActionError, toastBest, toastError, toastHeld, toastLanded, toastLinearHint, toastRerun, toastSyncWarning } from './toasts.tsx'
import { AgentsButton, QueueButton, RefreshControl } from './top-tools.tsx'
import { useMergeQueue } from './use-merge-queue.ts'
import { useSnapshot } from './use-snapshot.ts'
import { Icon } from './icons.tsx'

/** Set once the Linear setup notice has been dismissed for good in this browser. */
const LINEAR_HINT_HIDDEN = 'pr-dash:linear-hint-hidden'
/** How long a row stays after its pull request merged, while the merge plays out on it. */
const LANDING_MS = 1500
/** A merge older than this when it is first seen is not news: the dashboard was closed when it landed. */
const LANDED_NEWS_MS = 10 * 60 * 1000
/** The header draws a tick for each merge today, up to this many. */
const TICKS_SHOWN = 12

export function App() {
  const [prefs, setPrefs] = useState(() => withLocation(loadPreferences(), window.location.search))
  const snapshot = useSnapshot(prefs.page)
  const { data, booting, refreshing, status, progress, sync, setSync, refresh, mutate } = snapshot
  const [now, setNow] = useState(() => Date.now())
  const [linearHintHidden, setLinearHintHidden] = useState(() => {
    try {
      return localStorage.getItem(LINEAR_HINT_HIDDEN) === '1'
    } catch {
      return false
    }
  })
  /** Agents asked for that their provider has not made yet. */
  const [starting, setStarting] = useState<{ key: string; session: AgentSession }[]>([])
  const [holds, setHolds] = useState<Map<string, CheckHold[]>>(() => new Map())
  const [queue, setQueue] = useMergeQueue(() => void refresh({ force: true, focus: 'mine' }))

  useEffect(() => setSoundsEnabled(prefs.sounds), [prefs.sounds])
  // In a layout effect, so the first thing drawn already goes by the choice.
  useLayoutEffect(() => applyAnimations(prefs.animations), [prefs.animations])
  useEffect(() => applyTheme(prefs.theme), [prefs.theme])

  useEffect(() => {
    savePreferences(prefs)
    const search = locationSearch(prefs)
    if (search === window.location.search) return
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`)
    } catch {
      // Browsers cap how often the address may change. The next change catches up.
    }
  }, [prefs])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setHolds((current) => {
      if (current.size === 0) return current
      const byKey = new Map([...(data?.pullRequests ?? []), ...(data?.reviewPullRequests ?? [])].map((pr) => [pr.key, pr]))
      let changed = false
      const next = new Map<string, CheckHold[]>()
      for (const [key, list] of current) {
        const pr = byKey.get(key)
        const kept = pr ? reconcileHolds(list, pr.checks) : []
        if (kept.length !== list.length) changed = true
        if (kept.length > 0) next.set(key, kept)
      }
      if (!changed && next.size === current.size) return current
      return next
    })
  }, [data])

  const linearHint = Boolean(
    !linearHintHidden && data && !data.linearConfigured && [...data.pullRequests, ...(data.reviewPullRequests ?? [])].some((pr) => pr.linearIssues.length > 0),
  )

  useEffect(() => {
    toastSyncWarning(data?.warning ?? null, {
      onRetry: () => void refresh({ force: true }),
      onSettings: () => setPrefs((current) => ({ ...current, page: 'settings' })),
    })
  }, [data?.warning])

  useEffect(() => {
    toastLinearHint(linearHint, () => {
      try {
        localStorage.setItem(LINEAR_HINT_HIDDEN, '1')
      } catch {
        // Without storage it is hidden for this load only.
      }
      setLinearHintHidden(true)
    })
  }, [linearHint])

  const heldEntries = (queue?.entries ?? []).filter((entry) => entry.status === 'failed')
  // The notice is redrawn only when what it says would change, not on every queue poll.
  const heldKey = heldEntries.map((entry) => `${entry.id}:${entry.error ?? ''}:${entry.updatedAt}`).join('|')
  useEffect(() => {
    toastHeld(heldEntries, {
      onRetry: (entryId) => void changeQueue(() => api.retryMerge(entryId)),
      onView: () => setPrefs((current) => ({ ...current, page: 'queue' })),
    })
  }, [heldKey])

  // The tab's icon takes the list's most urgent colour, and its bars ripple while the queue works.
  const icon = useMemo(() => iconState(data, queue ? queueSummary(queue.entries) : null), [data, queue])
  const iconKey = JSON.stringify(icon)
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    let frame = 0
    const draw = () => {
      link.href = `data:image/svg+xml,${encodeURIComponent(iconSvg(icon, frame))}`
      frame = (frame + 1) % ICON_FRAMES
    }
    draw()
    if (!icon.merging || reducedMotion()) return
    const timer = window.setInterval(draw, 450)
    return () => window.clearInterval(timer)
  }, [iconKey])

  const page = prefs.page

  // Each page keeps its own scroll position, so a look at the queue or
  // settings comes back to the same place in the list.
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolls = useRef<Partial<Record<DashboardPage, number>>>({})
  const lastList = useRef<ListName>('mine')
  if (isListName(page)) lastList.current = page
  // The list on screen. Every other page works from your own.
  const list: ListName = page === 'review' ? 'review' : 'mine'
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrolls.current[page] ?? 0
  }, [page])
  // The desktop app's sidebar links to the agents, the queue and settings, and back to the list.
  useEffect(() => {
    return onDesktopEvent(window, 'pr-dash:page', (detail) => {
      const target = DESKTOP_PAGES.find((item) => item === detail)
      if (target) setPrefs((current) => ({ ...current, page: target === 'list' ? lastList.current : target }))
    })
  }, [])
  // The desktop app pairs with T3 Code from a tab, and says so here, where the setting is kept.
  useEffect(() => {
    return onDesktopEvent(window, 'pr-dash:t3', (heard) => {
      const detail = heard as { origin?: unknown; prompt?: unknown; failed?: unknown; show?: unknown } | null
      const origin = detail?.origin
      if (typeof origin === 'string') setPrefs((current) => ({ ...current, t3Origin: origin }))
      if (detail?.failed === true) {
        setPrefs((current) => ({ ...current, t3Origin: null }))
        toastError('T3 Code did not take the pairing link. Try again, or enter a pairing code under Agents in Settings.', {
          heading: 'Could not pair with T3 Code',
        })
      }
      if (detail?.prompt === false) setPrefs((current) => ({ ...current, t3PairPrompt: false }))
      if (detail?.show === true) setPrefs((current) => ({ ...current, page: 'settings', settingsTab: 'agents' }))
    })
  }, [])
  const viewPrefs = prefs.views[list]
  const watched = useMemo(() => new Set(data?.repos ?? []), [data?.repos])
  const mine = useMemo(
    () =>
      withStartingSessions(
        (data?.pullRequests ?? []).filter((pr) => watched.has(pr.repo)),
        starting,
      ),
    [data?.pullRequests, watched, starting],
  )
  const review = useMemo(
    () =>
      withStartingSessions(
        (data?.reviewPullRequests ?? []).filter((pr) => watched.has(pr.repo)),
        starting,
      ),
    [data?.reviewPullRequests, watched, starting],
  )
  const agents = useMemo(() => agentItems([...mine, ...review]), [mine, review])
  // A pull request that merged stays listed for a moment, so its row can show the merge before it goes.
  const merged = useMemo(() => new Map((data?.departed ?? []).filter((pr) => pr.outcome === 'merged').map((pr) => [pr.key, pr])), [data?.departed])
  const justMerged = (pr: { key: string }) => {
    const at = merged.get(pr.key)?.at
    return at != null && Date.now() - Date.parse(at) < LANDED_NEWS_MS
  }
  // With reduced motion there is nothing to play, so the row goes at once.
  const landingMs = reducedMotion() ? 0 : LANDING_MS
  const mineShown = useLingering(mine, justMerged, landingMs)
  const reviewShown = useLingering(review, justMerged, landingMs)
  const { list: prs, leaving } = page === 'review' ? reviewShown : mineShown
  const mergedToday = useMemo(() => {
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    return [...merged.values()].filter((pr) => pr.list === 'mine' && Date.parse(pr.at) >= midnight)
  }, [merged, now])
  // Pull requests you reviewed today, whether they are still open or have since merged or closed.
  const reviewedToday = useMemo(() => {
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    const gone = (data?.departed ?? []).filter((pr) => pr.list === 'review')
    const numbers = new Map<string, number>()
    for (const pr of [...review, ...gone]) {
      if (pr.viewerReviewedAt && Date.parse(pr.viewerReviewedAt) >= midnight) numbers.set(pr.key, pr.number)
    }
    return [...numbers.values()]
  }, [review, data?.departed, now])
  // The record is read again whenever the day's counts move, and a day or week that has just passed your best is celebrated.
  // The first read is where this starts from, so a record set while the dashboard was shut is not announced.
  const [activity, setActivity] = useState<Activity | null>(null)
  // Kept here so Settings shows the last answer at once on a return visit, and asks again behind it.
  const [agentChecks, setAgentChecks] = useState<AgentChecks | null>(null)
  const dashboardLoaded = data != null
  // Asked once the dashboard has loaded, so the Settings button can say a provider wants a look before Settings is opened.
  // Settings asks again each time its Agents group is shown.
  useEffect(() => {
    if (!dashboardLoaded) return
    let stale = false
    api
      .agentChecks()
      .then((next) => {
        if (!stale) setAgentChecks((current) => current ?? next)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [dashboardLoaded])
  const wants = settingsAttention({
    repos: data?.repos ?? [],
    agentRouting: data?.agents,
    agentChecks,
    t3Origin: prefs.t3Origin,
    t3PairPrompt: prefs.t3PairPrompt,
    status: sync,
  })
  // The first group with something to put right, which is where the Settings button goes, and what it is.
  const wantedTab = SETTINGS_TABS.find((tab) => wants[tab]) ?? null
  const settingsWants = wantedTab ? (wants[wantedTab] ?? null) : null
  // The desktop app's sidebar reads this off the page to mark its own Settings link.
  useEffect(() => {
    document.documentElement.dataset.settingsAttention = settingsWants ?? ''
  }, [settingsWants])
  const activitySeen = useRef<Activity | null>(null)
  const loaded = data != null
  const onActivity = page === 'activity'
  useEffect(() => {
    if (!loaded) return
    let stale = false
    api
      .activity()
      .then((next) => {
        if (stale) return
        const before = activitySeen.current
        activitySeen.current = next
        setActivity(next)
        if (before) toastBest(personalBests(before, next, Date.now()))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [loaded, onActivity, mergedToday.length, reviewedToday.length])
  // Say so when one of yours lands. The first snapshot is where this starts from, so old merges are not announced.
  const announced = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!data) return
    const before = announced.current
    announced.current = new Set(merged.keys())
    if (!before) return
    const landed = [...merged.values()].filter((pr) => pr.list === 'mine' && !before.has(pr.key) && Date.now() - Date.parse(pr.at) < LANDED_NEWS_MS)
    toastLanded(landed, mergedToday.length)
  }, [merged])
  const initiatives = data?.initiatives ?? []
  const initiativeCounts = useMemo(() => {
    const keys = new Map<string, Set<string>>()
    for (const pr of [...mine, ...review]) {
      for (const id of pr.initiativeIds) keys.set(id, (keys.get(id) ?? new Set()).add(pr.key))
    }
    return new Map([...keys].map(([id, set]) => [id, set.size]))
  }, [mine, review])
  const prByKey = useMemo(() => new Map(prs.map((pr) => [pr.key, pr])), [prs])
  const viewer = data?.viewer ?? null
  const flat = useMemo(() => new Set(viewPrefs.flat), [viewPrefs.flat])
  const outline = useMemo(
    () => buildOutline(prs, initiatives, viewPrefs.filters, prefs.sort, attentionOf(list), flat, viewer),
    [prs, initiatives, viewPrefs.filters, flat, prefs.sort, page, viewer],
  )
  const repos = useMemo(() => {
    const names = [...new Set(prs.map((pr) => pr.repo))]
    if (viewPrefs.filters.repo && !names.includes(viewPrefs.filters.repo)) names.push(viewPrefs.filters.repo)
    return names.sort()
  }, [prs, viewPrefs.filters.repo])
  const showRepo = useMemo(() => new Set(prs.map((pr) => pr.repo)).size > 1, [prs])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])
  const visible = !outlineEmpty(outline)
  const reviewBadge = review.filter((pr) => pr.reviewPending || needsAttention(pr, 'reviewer')).length
  const listPage = isListName(page)
  const filtersOn = JSON.stringify(viewPrefs.filters) !== JSON.stringify(DEFAULT_FILTERS)
  const matched = useMemo(() => {
    const names = new Map(initiatives.map((initiative) => [initiative.id, initiative.name]))
    return prs.filter((pr) => prMatches(pr, viewPrefs.filters, names, attentionOf(list), viewer)).length
  }, [prs, initiatives, viewPrefs.filters, page, viewer])
  const syncedAt = page === 'review' ? (data?.reviewSyncedAt ?? data?.syncedAt ?? null) : (data?.mineSyncedAt ?? data?.syncedAt ?? null)

  const applyFeedback = useCallback((key: string, counts: FeedbackCounts) => {
    snapshot.patch((current) => {
      const patch = (pr: PullRequest) => (pr.key === key ? { ...pr, ...counts, feedbackAt: pr.updatedAt } : pr)
      return {
        ...current,
        pullRequests: current.pullRequests.map(patch),
        reviewPullRequests: current.reviewPullRequests.map(patch),
      }
    })
  }, [])

  function patchFilters(patch: Partial<Filters>) {
    setPrefs((current) => {
      const target = isListName(current.page) ? current.page : 'mine'
      return {
        ...current,
        views: {
          ...current.views,
          [target]: {
            ...current.views[target],
            filters: { ...current.views[target].filters, ...patch },
          },
        },
      }
    })
  }

  async function changeQueue(work: () => Promise<QueueSnapshot>, refreshAfter = false) {
    clearActionError()
    try {
      setQueue(await work())
      if (refreshAfter) void refresh({ force: true, focus: 'mine' })
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : 'Could not update the merge queue', { heading: 'Could not update the merge queue' })
    }
  }

  /** Queues a merge. What was pressed folds into a parcel, which flies to the queue button once the queue has taken it. */
  function queueMerge(key: string, scope: 'pr' | 'downstack' | 'unapproved'): Promise<void> {
    const queued = api.enqueue(key, scope).then(setQueue)
    void sendOff(
      QUEUE_BUTTON,
      pressBox(),
      'Merge',
      queued.then(
        () => true,
        () => false,
      ),
    )
    return queued
  }

  function chooseSort(key: SortKey) {
    setPrefs((current) => {
      if (current.sort.key === key) {
        return { ...current, sort: { key, dir: current.sort.dir === 'asc' ? 'desc' : 'asc' } }
      }
      const dir = key === 'title' || key === 'repo' ? 'asc' : 'desc'
      return { ...current, sort: { key, dir } }
    })
  }

  return (
    <PrLinksProvider host={prefs.prLinks}>
      <MenuProvider>
        <RepoMarksProvider marks={data?.repoMarks}>
          <Toasts scheme={themeOf(prefs.theme).scheme} />
          <Shortcuts open={shortcutsOpen} onOpen={openShortcuts} onClose={closeShortcuts} />
          <div className="app">
            <header className="top">
              <nav className="nav" aria-label="Lists">
                <button type="button" className="tab" aria-pressed={page === 'mine'} onClick={() => setPrefs((current) => ({ ...current, page: 'mine' }))}>
                  My PRs
                </button>
                <button type="button" className="tab" aria-pressed={page === 'review'} onClick={() => setPrefs((current) => ({ ...current, page: 'review' }))}>
                  Review
                  {reviewBadge > 0 ? <Roll className="nav-count" value={reviewBadge} /> : null}
                </button>
                <button
                  type="button"
                  className="tab"
                  aria-pressed={page === 'activity'}
                  onClick={() => setPrefs((current) => ({ ...current, page: 'activity' }))}
                >
                  Activity
                </button>
              </nav>
              <div className="top-tools">
                {listPage && mergedToday.length + reviewedToday.length > 0 ? (
                  <button type="button" className="tally" aria-label="Activity" onClick={() => setPrefs((current) => ({ ...current, page: 'activity' }))}>
                    {mergedToday.length > 0 ? (
                      <span className="tally-part" title={`Your pull requests merged today: ${mergedToday.map((pr) => `#${pr.number}`).join(', ')}`}>
                        <span className="ticks" aria-hidden="true">
                          {mergedToday.slice(0, TICKS_SHOWN).map((pr) => (
                            <i key={pr.key} />
                          ))}
                        </span>
                        <span>
                          <Roll value={mergedToday.length} /> merged
                        </span>
                      </span>
                    ) : null}
                    {reviewedToday.length > 0 ? (
                      <span
                        className="tally-part reviewed"
                        title={`Pull requests you reviewed today: ${reviewedToday.map((number) => `#${number}`).join(', ')}`}
                      >
                        <span className="ticks" aria-hidden="true">
                          {reviewedToday.slice(0, TICKS_SHOWN).map((number) => (
                            <i key={number} />
                          ))}
                        </span>
                        <span>
                          <Roll value={reviewedToday.length} /> reviewed
                        </span>
                      </span>
                    ) : null}
                    <span>today</span>
                  </button>
                ) : null}
                {page === 'settings' ? null : (
                  <RefreshControl
                    refreshing={refreshing}
                    status={status}
                    progress={progress}
                    syncedAt={syncedAt}
                    now={now}
                    onRefresh={() => void refresh({ force: true })}
                  />
                )}
                <AgentsButton
                  statuses={agents.map((item) => item.session.status)}
                  pressed={page === 'agents'}
                  onClick={() => setPrefs((current) => ({ ...current, page: 'agents' }))}
                />
                <QueueButton queue={queue} pressed={page === 'queue'} onClick={() => setPrefs((current) => ({ ...current, page: 'queue' }))} />
                <button
                  type="button"
                  className="tool-btn"
                  aria-pressed={shortcutsOpen}
                  aria-label="Keyboard shortcuts"
                  aria-keyshortcuts="?"
                  title="Keyboard shortcuts (?)"
                  onClick={() => setShortcutsOpen((current) => !current)}
                >
                  <Icon name="keyboard" />
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  aria-pressed={page === 'settings'}
                  aria-label="Settings"
                  title={settingsWants ? `Settings · ${settingsWants}` : 'Settings'}
                  onClick={() => setPrefs((current) => ({ ...current, page: 'settings', settingsTab: wantedTab ?? current.settingsTab }))}
                >
                  <Icon name="settings" />
                  {settingsWants ? <span className="pip waiting" /> : null}
                </button>
              </div>
            </header>
            {listPage ? (
              <FilterBar
                page={page}
                filters={viewPrefs.filters}
                filtersOn={filtersOn}
                prs={prs}
                repos={repos}
                initiatives={initiatives}
                viewer={viewer}
                matched={matched}
                onPatch={patchFilters}
                onClear={() => patchFilters(DEFAULT_FILTERS)}
                onManageInitiatives={() => setPrefs((current) => ({ ...current, page: 'settings' }))}
              />
            ) : null}
            <div
              className="scroll"
              ref={scrollRef}
              onScroll={(event) => {
                scrolls.current[page] = event.currentTarget.scrollTop
              }}
            >
              {page === 'settings' ? (
                <SettingsPage
                  tab={prefs.settingsTab}
                  onTab={(settingsTab) => setPrefs((current) => ({ ...current, settingsTab }))}
                  status={sync}
                  repos={data?.repos ?? []}
                  mineSyncedAt={data?.mineSyncedAt ?? null}
                  reviewSyncedAt={data?.reviewSyncedAt ?? null}
                  onEnqueue={function enqueue(kind) {
                    void api
                      .enqueueSync(kind, snapshot.focus())
                      .then(setSync)
                      .catch((caught) => {
                        toastError(caught instanceof Error ? caught.message : 'Could not queue that sync', {
                          heading: 'Could not queue that sync',
                          onRetry: () => enqueue(kind),
                        })
                      })
                  }}
                  onCancelSync={(id) => {
                    void api
                      .cancelSync(id)
                      .then(setSync)
                      .catch((caught) => {
                        toastError(caught instanceof Error ? caught.message : 'Could not cancel that sync', { heading: 'Could not cancel that sync' })
                      })
                  }}
                  initiatives={
                    <ManageInitiatives
                      initiatives={initiatives}
                      counts={initiativeCounts}
                      onCreate={(name) => mutate(() => api.createInitiative(name))}
                      onRename={(id, name) => mutate(() => api.renameInitiative(id, name))}
                      onDelete={(id) => mutate(() => api.deleteInitiative(id))}
                    />
                  }
                  prLinks={prefs.prLinks}
                  onPrLinks={(prLinks) => setPrefs((current) => ({ ...current, prLinks }))}
                  theme={prefs.theme}
                  onTheme={(theme) => setPrefs((current) => ({ ...current, theme }))}
                  sounds={prefs.sounds}
                  onSounds={(sounds) => setPrefs((current) => ({ ...current, sounds }))}
                  animations={prefs.animations}
                  onAnimations={(animations) => setPrefs((current) => ({ ...current, animations }))}
                  mergeUnapproved={prefs.mergeUnapproved}
                  onMergeUnapproved={(mergeUnapproved) => setPrefs((current) => ({ ...current, mergeUnapproved }))}
                  onAddRepo={async (repo) => {
                    snapshot.show(await api.addRepo(repo))
                    void refresh({ force: true, full: true, focus: snapshot.focus() })
                  }}
                  onRemoveRepo={async (repo) => {
                    snapshot.show(await api.removeRepo(repo))
                  }}
                  onRepoMark={async (repo, mark) => {
                    snapshot.show(await api.setRepoMark(repo, mark))
                  }}
                  onAgents={snapshot.show}
                  agentRouting={data?.agents}
                  agentChecks={agentChecks}
                  onAgentChecks={setAgentChecks}
                  t3Origin={prefs.t3Origin}
                  onT3Origin={(t3Origin) => setPrefs((current) => ({ ...current, t3Origin }))}
                  t3PairPrompt={prefs.t3PairPrompt}
                />
              ) : null}
              {page === 'activity' ? <ActivityPage activity={activity} now={now} /> : null}
              {page === 'agents' ? (
                <AgentProvider
                  start={() => Promise.reject(new Error('Start an agent from its pull request.'))}
                  routing={data?.agents}
                  t3Origin={prefs.t3Origin}
                >
                  <AgentsPage items={agents} />
                </AgentProvider>
              ) : null}
              {page === 'queue' ? (
                <MergeQueuePage
                  queue={queue}
                  onCancel={(id) => changeQueue(() => api.cancelMerge(id), true)}
                  onRetry={(id) => changeQueue(() => api.retryMerge(id))}
                  onMove={(id, direction) => changeQueue(() => api.moveMerge(id, direction))}
                />
              ) : null}
              {listPage && booting && prs.length === 0 ? <SkeletonTable mode={list} note="Loading saved pull requests…" /> : null}
              {listPage && !booting && prs.length === 0 && refreshing ? (
                <>
                  <SkeletonTable mode={list} note={status} />
                  <p className="skeleton-note" aria-hidden="true">
                    {status}
                  </p>
                </>
              ) : null}
              {listPage && !booting && data && data.repos.length === 0 && !refreshing ? (
                <div className="empty">
                  <h2>No repositories selected</h2>
                  <p>Choose which repositories to sync. Until you do, this dashboard does not ask GitHub for pull requests.</p>
                  <button type="button" className="primary" onClick={() => setPrefs((current) => ({ ...current, page: 'settings' }))}>
                    Choose repositories
                  </button>
                </div>
              ) : null}
              {page === 'mine' && !booting && data && data.repos.length > 0 && prs.length === 0 && !refreshing ? (
                <div className="empty">
                  <h2>No open pull requests</h2>
                  <p>This view is pull requests you authored. Refresh again after the next one is open.</p>
                </div>
              ) : null}
              {page === 'review' && !booting && data && data.repos.length > 0 && prs.length === 0 && !refreshing ? (
                <div className="empty">
                  <h2>No pull requests to review</h2>
                  <p>This view is open pull requests that request your review, including your teams, and open pull requests you have already reviewed.</p>
                </div>
              ) : null}
              {listPage && prs.length > 0 && !visible ? (
                <div className="empty">
                  <h2>Nothing matches</h2>
                  {filtersOn ? (
                    <>
                      <p>No pull request here matches {activeFilterLabels(viewPrefs.filters, list, initiatives).join(', ')}.</p>
                      <button type="button" className="primary" onClick={() => patchFilters(DEFAULT_FILTERS)}>
                        Clear filters
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {listPage && prs.length > 0 && visible ? (
                <PrTable
                  mode={list}
                  outline={outline}
                  sort={prefs.sort}
                  initiatives={initiatives}
                  prByKey={prByKey}
                  showRepo={showRepo}
                  expanded={new Set(prefs.expanded)}
                  collapsed={new Set(prefs.collapsed)}
                  queueByKey={rowMarks(queue?.entries ?? [])}
                  onSort={chooseSort}
                  onToggle={(id) => {
                    fold(!prefs.expanded.includes(id))
                    setPrefs((current) => ({
                      ...current,
                      expanded: current.expanded.includes(id) ? current.expanded.filter((item) => item !== id) : [...current.expanded, id],
                    }))
                  }}
                  onToggleSection={(id) => {
                    fold(prefs.collapsed.includes(id))
                    setPrefs((current) => ({
                      ...current,
                      collapsed: current.collapsed.includes(id) ? current.collapsed.filter((item) => item !== id) : [...current.collapsed, id],
                    }))
                  }}
                  onAssign={(initiativeId, keys, action) => mutate(() => api.assign(initiativeId, keys, action))}
                  onCreateAssigned={async (name, keys) => {
                    const before = new Set(initiatives.map((initiative) => initiative.id))
                    await mutate(async () => {
                      const snap = await api.createInitiative(name)
                      const created = snap.initiatives.find((initiative) => !before.has(initiative.id))
                      if (!created) return snap
                      return api.assign(created.id, keys, 'add')
                    })
                  }}
                  flat={flat}
                  onToggleFlat={(id) =>
                    setPrefs((current) => {
                      const target = isListName(current.page) ? current.page : 'mine'
                      const view = current.views[target]
                      const flat = view.flat.includes(id) ? view.flat.filter((item) => item !== id) : [...view.flat, id]
                      return { ...current, views: { ...current.views, [target]: { ...view, flat } } }
                    })
                  }
                  linearConfigured={Boolean(data?.linearConfigured)}
                  viewer={viewer}
                  onFeedback={applyFeedback}
                  leaving={leaving}
                  onUpdateIssue={(identifier, patch) => mutate(() => api.updateLinearIssue(identifier, patch))}
                  onLinkIssue={(key, identifier) => mutate(() => api.linkLinearIssue(key, identifier))}
                  onMerge={(key) => queueMerge(key, 'pr')}
                  onMergeUnapproved={prefs.mergeUnapproved ? (key) => queueMerge(key, 'unapproved') : undefined}
                  onRetry={async (entryId) => {
                    setQueue(await api.retryMerge(entryId))
                  }}
                  onStackMerge={(key) => queueMerge(key, 'downstack')}
                  onMarkReady={async (key) => {
                    snapshot.replace(await api.markReady(key))
                  }}
                  holds={holds}
                  onRerun={async function rerun(keys, mode): Promise<string> {
                    const keySet = new Set(keys)
                    const targeted = prs.filter((pr) => keySet.has(pr.key))
                    const optimistic = collectHolds(targeted, mode, null)
                    setHolds((current) => mergeHolds(current, optimistic))
                    try {
                      const result = await api.rerun(keys, mode)
                      const restarted = new Set(result.runs.map((run) => `${run.repo}#${run.runId}`))
                      const confirmed = collectHolds(targeted, mode, restarted)
                      setHolds((current) => mergeHolds(withoutHolds(current, optimistic), confirmed))
                      const text = result.errors.length
                        ? `Reran ${result.reran}. ${result.errors[0]}`
                        : `Reran ${result.reran} workflow${result.reran === 1 ? '' : 's'}.`
                      toastRerun(result, () => void rerun(keys, 'failed').catch(() => undefined))
                      void refresh({ force: true })
                      return text
                    } catch (caught) {
                      setHolds((current) => withoutHolds(current, optimistic))
                      throw caught
                    }
                  }}
                  onRebase={async (key) => {
                    try {
                      snapshot.replace(await api.rebase(key))
                    } finally {
                      void refresh({ force: true })
                    }
                  }}
                  onRefreshPr={async (key) => {
                    snapshot.replace(await api.refreshPull(key))
                  }}
                  agentRouting={data?.agents}
                  t3Origin={prefs.t3Origin}
                  onStartAgent={async (key, request, provider) => {
                    // The provider can take a while to make the session, so one stands in for it at once:
                    // the row, the Agents page and the count all have it from the press.
                    const session = startingSession(request, provider ?? providerFor(data?.agents, pullKeyRepo(key)))
                    setStarting((current) => [...current, { key, session }])
                    try {
                      const result = await api.startAgent(key, request, provider)
                      snapshot.replace(result.snapshot)
                      return { url: result.url, environmentId: result.environmentId ?? null }
                    } finally {
                      // Taken away in the same turn as the list with the real one is put in, so the count never dips.
                      setStarting((current) => current.filter((item) => item.session !== session))
                    }
                  }}
                />
              ) : null}
            </div>
          </div>
        </RepoMarksProvider>
      </MenuProvider>
    </PrLinksProvider>
  )
}
