import { clipboard, ipcMain, Menu, shell, WebContentsView, type BaseWindow, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Snapshot, Sort } from '../../src/shared/types.ts'
import {
  buildSidebar,
  GROUPINGS,
  isGrouping,
  prRef,
  pruneAgentState,
  runsShownAt,
  unreadRuns,
  type AgentState,
  type DashboardPrefs,
  type Grouping,
  type SidebarModel,
  type TabInfo,
} from './sidebar.ts'

export const STRIP_HEIGHT = 40
const SIDEBAR_WIDTH = 264
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 560
const PAGE_MIN = 320
const ZOOM_LIMIT = 4
const SNAPSHOT_INTERVAL_MS = 30_000
const PREFERENCES_KEY = 'pr-dash.preferences.v1'

type Tab = {
  id: number
  view: WebContentsView
  pinned: boolean
  title: string
  favicon: string | null
  loading: boolean
  url: string
  /** Where the sidebar files this tab. It follows `url` except while the tab is the one being looked at. */
  placedUrl: string
  /** False until the first page has loaded, so a redirect on the way in still decides the tab's place. */
  settled: boolean
  parent: number | null
}

/** `parents` holds, for each address, the index of the tab it was opened from. */
export type SavedTabs = { urls: string[]; active: number; parents?: (number | null)[] }

export type SidebarState = { open: boolean; width: number; grouping: Grouping; collapsed: string[]; earlierOpen: boolean }

/** A page of the dashboard the sidebar links to. `list` is whichever list was open last. */
type DashboardPage = 'list' | 'queue' | 'settings'

export type TabsOptions = { sidebar?: Partial<SidebarState> | null; agentFile: string }

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Where a tab is now, or where it is headed while its first page loads. */
function linkOf(tab: Tab): string {
  return tab.view.webContents.getURL() || tab.url
}

// One window: the tab strip on top, the active tab's page below. The first
// tab is the dashboard and cannot be closed.
export class Tabs {
  private readonly chrome: WebContentsView
  private readonly tabs: Tab[] = []
  private readonly closed: string[] = []
  private activeId = 0
  private nextId = 0
  private updateReady = false
  private readonly sidebar: SidebarState
  private readonly agentFile: string
  private agentState: AgentState
  private data: Snapshot | null = null
  private prefs: DashboardPrefs = { mineByIssue: true, reviewByIssue: true }
  private overlay = false
  /** Agent runs read in the active tab, kept in their row until another tab is chosen. */
  private held: string[] = []
  /** Tabs in the order they were last looked at, newest last. */
  private readonly visited: number[] = []
  private fetching = false
  private refreshTimer: NodeJS.Timeout | null = null
  onChange: () => void = () => {}
  onApplyUpdate: () => void = () => {}

  constructor(
    private readonly win: BaseWindow,
    private readonly session: Session,
    private readonly dashboardUrl: string,
    options: TabsOptions,
  ) {
    this.sidebar = {
      open: options.sidebar?.open === true,
      width: clampWidth(options.sidebar?.width),
      grouping: isGrouping(options.sidebar?.grouping) ? options.sidebar.grouping : 'match',
      collapsed: Array.isArray(options.sidebar?.collapsed) ? options.sidebar.collapsed.filter((id) => typeof id === 'string') : [],
      earlierOpen: options.sidebar?.earlierOpen === true,
    }
    this.agentFile = options.agentFile
    this.agentState = readAgentState(options.agentFile)
    this.chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.cjs') } })
    // The view fills the window: the sidebar and the strip are its opaque
    // parts, and the rest shows through to the page when a menu raises it.
    this.chrome.setBackgroundColor('#00000000')
    win.contentView.addChildView(this.chrome)
    void this.chrome.webContents.loadFile(path.join(__dirname, 'chrome', 'index.html'))
    // The strip's zoom is remembered between launches, and the page below has to start where the strip ends.
    this.chrome.webContents.on('did-finish-load', () => this.layout())

    ipcMain.on('chrome', (event, command: string, arg?: number | string | boolean) => {
      if (event.sender !== this.chrome.webContents) return
      const id = typeof arg === 'number' ? arg : undefined
      const key = typeof arg === 'string' ? arg : undefined
      if (command === 'ready') this.publish()
      else if (command === 'select' && typeof id === 'number') this.activate(id)
      else if (command === 'close' && typeof id === 'number') this.close(id)
      else if (command === 'toggle-sidebar') this.toggleSidebar()
      else if (command === 'grouping-menu') this.groupingMenu()
      else if (command === 'toggle-group' && key) this.toggleGroup(key)
      else if (command === 'toggle-earlier') this.setSidebar({ earlierOpen: !this.sidebar.earlierOpen })
      else if (command === 'agent-open' && key) this.openAgent(key)
      else if (command === 'agent-dismiss' && key) this.dismissAgent(key)
      else if (command === 'agents-clear') this.clearUnread()
      else if (command === 'overlay') this.setOverlay(arg === true)
      else if (command === 'sidebar-width' && typeof id === 'number') this.setWidth(id)
      else if (command === 'dashboard' && (key === 'list' || key === 'queue' || key === 'settings')) this.showDashboard(key)
      else if (command === 'back') this.back()
      else if (command === 'forward') this.forward()
      else if (command === 'reload') this.reload()
      else if (command === 'open-external') this.openExternal()
      else if (command === 'copy-link') this.copyLink()
      else if (command === 'tab-menu' && typeof id === 'number') this.tabMenu(id)
      else if (command === 'apply-update') this.onApplyUpdate()
    })

    for (const event of ['resize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.on(event as 'resize', () => {
        this.layout()
        this.publish()
      })
    }

    const dashboard = this.create(dashboardUrl, { pinned: true })
    // The local API can merge pull requests and has no login. Only the
    // dashboard tab may call it; a page in another tab may not.
    const apiOrigin = new URL(dashboardUrl).origin
    session.webRequest.onBeforeRequest({ urls: [`${apiOrigin}/*`] }, (details, done) => {
      done({ cancel: details.webContentsId !== dashboard.view.webContents.id })
    })
    // The dashboard reads the snapshot again whenever something changes, and
    // writes when the user acts. Either is the moment to read it here too.
    session.webRequest.onCompleted({ urls: [`${apiOrigin}/api/*`] }, (details) => {
      if (details.method !== 'GET' || details.url.includes('/api/snapshot')) this.refreshSoon()
    })
    win.on('focus', () => {
      this.noteSeen()
      this.publish()
    })
    const poll = setInterval(() => void this.refresh(), SNAPSHOT_INTERVAL_MS)
    win.on('closed', () => clearInterval(poll))
    void this.refresh()
    this.activate(dashboard.id)
  }

  get sidebarState(): SidebarState {
    return this.sidebar
  }

  toggleSidebar() {
    this.setSidebar({ open: !this.sidebar.open })
    this.layout()
  }

  private setWidth(width: number) {
    this.sidebar.width = clampWidth(width)
    this.layout()
    this.changed()
  }

  /** Zooms the strip and sidebar when they have the keyboard, and the page otherwise. Null goes back to actual size. */
  zoom(step: number | null) {
    const target = this.chrome.webContents.isFocused() ? this.chrome.webContents : this.active.view.webContents
    target.setZoomLevel(step === null ? 0 : Math.max(-ZOOM_LIMIT, Math.min(ZOOM_LIMIT, target.getZoomLevel() + step)))
    this.layout()
  }

  // The dashboard is one page that shows a list, the merge queue or settings.
  // It keeps its own scroll position for each, so this only asks it to switch.
  private showDashboard(page: DashboardPage) {
    this.activate(this.dashboard.id)
    const contents = this.dashboard.view.webContents
    if (page === 'list' && dashboardPage(this.dashboard.url) === 'list') return
    void contents.executeJavaScript(`window.dispatchEvent(new CustomEvent('pr-dash:page', { detail: ${JSON.stringify(page)} }))`).catch(() => undefined)
  }

  private setSidebar(patch: Partial<SidebarState>) {
    Object.assign(this.sidebar, patch)
    this.changed()
  }

  private toggleGroup(id: string) {
    const collapsed = this.sidebar.collapsed.includes(id) ? this.sidebar.collapsed.filter((item) => item !== id) : [...this.sidebar.collapsed, id]
    this.setSidebar({ collapsed })
  }

  private groupingMenu() {
    Menu.buildFromTemplate(
      GROUPINGS.map(({ value, label }) => ({
        label,
        type: 'radio' as const,
        checked: this.sidebar.grouping === value,
        click: () => this.setSidebar({ grouping: value }),
      })),
    ).popup({ window: this.win })
  }

  // A menu drawn by the strip has to sit over the page, so the strip's view
  // goes on top while one is open.
  private setOverlay(on: boolean) {
    this.overlay = on
    this.layout()
    if (on) this.chrome.webContents.focus()
    else this.active.view.webContents.focus()
  }

  private model(): SidebarModel {
    return buildSidebar({
      tabs: this.tabs.map((tab): TabInfo => ({ id: tab.id, pinned: tab.pinned, url: tab.url, placedUrl: tab.placedUrl, title: tab.title, favicon: tab.favicon, loading: tab.loading, parent: tab.parent })),
      activeId: this.activeId,
      data: this.data,
      grouping: this.sidebar.grouping,
      prefs: this.prefs,
      collapsed: this.sidebar.collapsed,
      agentState: this.agentState,
      held: this.held,
      now: Date.now(),
    })
  }

  /** Tabs in the order the user sees them: the sidebar's when it is open, the strip's otherwise. */
  private ordered(): Tab[] {
    if (!this.sidebar.open) return this.tabs
    const byId = new Map(this.tabs.map((tab) => [tab.id, tab]))
    return [this.dashboard, ...this.model().order.flatMap((id) => byId.get(id) ?? [])]
  }

  private refreshSoon() {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, 250)
  }

  private async refresh() {
    if (this.fetching || this.win.isDestroyed()) return
    this.fetching = true
    try {
      const res = await fetch(`${this.dashboardUrl}/api/snapshot`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        this.data = (await res.json()) as Snapshot
        this.saveAgentState(pruneAgentState(this.agentState, this.data))
      }
      await this.readPrefs()
    } catch {
      // The server restarts during an update. The last snapshot stays until the next read.
    } finally {
      this.fetching = false
    }
    if (this.win.isDestroyed()) return
    this.noteSeen()
    this.publish()
  }

  // How the dashboard groups its lists lives in the dashboard page's own storage.
  private async readPrefs() {
    const contents = this.dashboard.view.webContents
    if (contents.isDestroyed() || contents.isLoading()) return
    const raw: unknown = await contents.executeJavaScript(`localStorage.getItem(${JSON.stringify(PREFERENCES_KEY)})`)
    if (typeof raw !== 'string') return
    const { views, sort } = JSON.parse(raw) as { views?: Record<string, { byIssue?: boolean } | undefined>; sort?: Partial<Sort> }
    this.prefs = {
      mineByIssue: views?.mine?.byIssue !== false,
      reviewByIssue: views?.review?.byIssue !== false,
      sort: typeof sort?.key === 'string' && (sort.dir === 'asc' || sort.dir === 'desc') ? { key: sort.key, dir: sort.dir } : undefined,
    }
  }

  private saveAgentState(next: AgentState) {
    if (JSON.stringify(next) === JSON.stringify(this.agentState)) return
    this.agentState = next
    try {
      writeFileSync(this.agentFile, JSON.stringify(next))
    } catch {
      // Read state is a convenience; the app works without it being kept.
    }
  }

  private markSeen(keys: string[]) {
    if (keys.length === 0) return
    const now = new Date().toISOString()
    this.saveAgentState({ ...this.agentState, seen: { ...this.agentState.seen, ...Object.fromEntries(keys.map((key) => [key, now])) } })
  }

  // An agent that finishes while its tab is in front has been seen. Its row
  // stays where it is until the user moves on, so it does not jump on a click.
  private noteSeen() {
    if (!this.win.isFocused()) return
    const keys = runsShownAt(this.active.url, this.data, this.agentState)
    this.held.push(...keys)
    this.markSeen(keys)
  }

  private openAgent(key: string) {
    const row = [...this.model().agents, ...this.model().earlier].find((item) => item.key === key)
    if (!row) return
    if (row.tabId !== null) this.activate(row.tabId)
    else this.open(row.url)
    if (row.mark !== 'read') this.held.push(key)
    this.markSeen([key])
    this.publish()
  }

  private dismissAgent(key: string) {
    const row = this.model().agents.find((item) => item.key === key)
    if (!row) return
    this.saveAgentState({ ...this.agentState, dismissed: [...this.agentState.dismissed, key] })
    if (row.tabId !== null) this.close(row.tabId)
    this.publish()
  }

  private clearUnread() {
    this.markSeen(unreadRuns(this.data, this.agentState))
    this.publish()
  }

  get dashboardActive(): boolean {
    return this.active.pinned
  }

  private get active(): Tab {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0]!
  }

  private get dashboard(): Tab {
    return this.tabs[0]!
  }

  open(url: string, options: { background?: boolean; after?: Tab; reuse?: boolean } = {}) {
    if (!isWebUrl(url)) return
    const from = options.after ?? this.active
    const existing = options.reuse ? this.showing(url) : null
    if (existing) {
      // A link to a place inside the pull request still has to land there.
      if (existing.url !== url && prRef(url)?.bare === false) void existing.view.webContents.loadURL(url).catch(() => undefined)
      if (!options.background) this.activate(existing.id)
      return
    }
    const tab = this.create(url, { after: from, parent: from.pinned ? null : from.id })
    if (!options.background) this.activate(tab.id)
    else this.changed()
  }

  /** The tab already on this pull request or Cursor agent, when there is one. */
  private showing(url: string): Tab | null {
    const ref = prRef(url)
    if (ref) return this.tabs.find((tab) => !tab.pinned && prRef(tab.url)?.key === ref.key) ?? null
    const agent = /^https:\/\/cursor\.com\/agents\/([\w-]+)$/.exec(url)?.[1]
    return agent ? (this.tabs.find((tab) => !tab.pinned && tab.url.startsWith('https://cursor.com/') && tab.url.includes(agent)) ?? null) : null
  }

  async openFromClipboard() {
    const text = (await clipboard.readText()).trim()
    if (isWebUrl(text)) this.open(text)
    else shell.beep()
  }

  restore(saved: SavedTabs | null) {
    if (!saved) return
    const made = saved.urls.map((url) => (isWebUrl(url) ? this.create(url, {}) : null))
    for (const [index, tab] of made.entries()) {
      const parent = saved.parents?.[index]
      if (tab && typeof parent === 'number') tab.parent = made[parent]?.id ?? null
    }
    const target = this.tabs[saved.active]
    if (target) this.activate(target.id)
  }

  snapshot(): SavedTabs {
    const kept = this.tabs.filter((tab) => !tab.pinned && isWebUrl(tab.view.webContents.getURL()))
    const parents = kept.map((tab) => {
      const index = kept.findIndex((other) => other.id === tab.parent)
      return index < 0 ? null : index
    })
    return {
      urls: kept.map((tab) => tab.view.webContents.getURL()),
      active: this.tabs.indexOf(this.active),
      parents,
    }
  }

  closeActive() {
    this.close(this.activeId)
  }

  reopenClosed() {
    const url = this.closed.pop()
    if (url) this.open(url)
  }

  step(by: number) {
    const tabs = this.ordered()
    const index = (tabs.indexOf(this.active) + by + tabs.length) % tabs.length
    this.activate(tabs[index]!.id)
  }

  // Cmd+1 is the dashboard; Cmd+9 is the last tab, as in a browser.
  selectIndex(index: number) {
    const tabs = this.ordered()
    const tab = index === 8 ? tabs.at(-1) : tabs[index]
    if (tab) this.activate(tab.id)
  }

  back() {
    const history = this.active.view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward() {
    const history = this.active.view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload() {
    this.active.view.webContents.reload()
  }

  reloadDashboard() {
    this.dashboard.view.webContents.reload()
  }

  openExternal() {
    void shell.openExternal(this.active.view.webContents.getURL())
  }

  copyLink() {
    if (!this.active.pinned) clipboard.writeText(linkOf(this.active))
  }

  // A right click on a tab in the strip or the sidebar. The tab need not be the one showing.
  private tabMenu(id: number) {
    const tab = this.tabs.find((item) => item.id === id)
    if (!tab || tab.pinned) return
    Menu.buildFromTemplate([
      { label: 'Copy Link', click: () => clipboard.writeText(linkOf(tab)) },
      { label: 'Open in Browser', click: () => void shell.openExternal(linkOf(tab)) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.close(id) },
    ]).popup({ window: this.win })
  }

  toggleDevTools() {
    this.active.view.webContents.toggleDevTools()
  }

  setUpdateReady(ready: boolean) {
    this.updateReady = ready
    this.publish()
  }

  private create(url: string, options: { pinned?: boolean; after?: Tab; adopt?: WebContents; parent?: number | null }): Tab {
    const view = new WebContentsView(options.adopt ? { webContents: options.adopt } : { webPreferences: { session: this.session } })
    view.setBackgroundColor('#10110f')
    view.setVisible(false)
    const tab: Tab = { id: this.nextId++, view, pinned: options.pinned ?? false, title: options.pinned ? 'Pull requests' : url, favicon: null, loading: !options.adopt, url, placedUrl: url, settled: false, parent: options.parent ?? null }
    const at = options.after ? this.tabs.indexOf(options.after) + 1 : this.tabs.length
    this.tabs.splice(at, 0, tab)
    this.win.contentView.addChildView(view)
    this.wire(tab)
    if (!options.adopt) void view.webContents.loadURL(url).catch(() => undefined)
    return tab
  }

  private wire(tab: Tab) {
    const contents = tab.view.webContents
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // A script-opened popup (a sign-in window, say) needs to stay a real
      // window so it can talk to the page that opened it.
      if (disposition === 'new-window') return { action: 'allow' }
      // A page can open an empty tab during a click and send it to an address
      // later, as the dashboard does while a Cursor agent starts. The page
      // needs that tab's window back, so the tab takes the contents Electron
      // made for it instead of loading its own.
      if (url === 'about:blank') {
        return {
          action: 'allow',
          createWindow: (options) => {
            const adopt = (options as { webContents: WebContents }).webContents
            const opened = this.create(url, { after: tab, adopt, parent: tab.pinned ? null : tab.id })
            if (disposition === 'background-tab') this.changed()
            else this.activate(opened.id)
            return adopt
          },
        }
      }
      this.open(url, { background: disposition === 'background-tab', after: tab, reuse: tab.pinned })
      return { action: 'deny' }
    })
    if (tab.pinned) {
      contents.on('will-navigate', (event) => {
        if (new URL(event.url).origin === new URL(this.dashboardUrl).origin) return
        event.preventDefault()
        this.open(event.url, { after: tab, reuse: true })
      })
    } else {
      contents.on('page-title-updated', (_event, title) => {
        tab.title = title
        this.publish()
      })
      contents.on('page-favicon-updated', (_event, favicons) => {
        tab.favicon = favicons[0] ?? null
        this.publish()
      })
    }
    contents.on('did-start-loading', () => {
      tab.loading = true
      this.publish()
    })
    contents.on('did-stop-loading', () => {
      tab.loading = false
      tab.settled = true
      this.publish()
    })
    const navigated = () => {
      const url = contents.getURL()
      if (url) tab.url = url
      // The row of the tab being looked at keeps its place, so nothing moves
      // under the pointer. It is filed again when another tab takes over.
      if (tab.id !== this.activeId || !tab.settled) tab.placedUrl = tab.url
      this.noteSeen()
      this.changed()
    }
    contents.on('did-navigate', navigated)
    contents.on('did-navigate-in-page', navigated)
    contents.on('context-menu', (_event, params) => this.contextMenu(tab, params))
  }

  private contextMenu(tab: Tab, params: Electron.ContextMenuParams) {
    const contents = tab.view.webContents
    const items: MenuItemConstructorOptions[] = []
    if (isWebUrl(params.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.open(params.linkURL, { background: true, after: tab }) },
        { label: 'Open Link in Browser', click: () => void shell.openExternal(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
    else if (params.selectionText.trim()) items.push({ role: 'copy' }, { type: 'separator' })
    items.push(
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Open Page in Browser', click: () => void shell.openExternal(contents.getURL()) },
      { label: 'Copy Page Link', click: () => clipboard.writeText(contents.getURL()) },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
    )
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  private activate(id: number) {
    if (!this.tabs.some((tab) => tab.id === id)) return
    const previous = this.active
    if (previous.id !== id) {
      previous.placedUrl = previous.url
      this.held = []
    }
    this.visited.splice(0, this.visited.length, ...this.visited.filter((item) => item !== id), id)
    this.activeId = id
    this.noteSeen()
    for (const tab of this.tabs) tab.view.setVisible(tab.id === id)
    this.layout()
    this.active.view.webContents.focus()
    this.changed()
  }

  private close(id: number) {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    const tab = this.tabs[index]
    if (!tab || tab.pinned) return
    const url = tab.view.webContents.getURL()
    if (isWebUrl(url)) this.closed.push(url)
    this.tabs.splice(index, 1)
    for (const other of this.tabs) if (other.parent === id) other.parent = null
    this.visited.splice(0, this.visited.length, ...this.visited.filter((item) => item !== id))
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    // Closing a tab goes back to the one looked at before it.
    if (this.activeId === id) this.activate(this.visited.at(-1) ?? (this.tabs[index] ?? this.tabs[index - 1])!.id)
    else this.changed()
  }

  private layout() {
    const { width, height } = this.win.getContentBounds()
    // The strip and sidebar are sized in their own page's units, which zooming scales.
    const zoom = this.chrome.webContents.getZoomFactor()
    const left = this.sidebar.open ? Math.round(Math.min(this.sidebar.width * zoom, Math.max(0, width - PAGE_MIN))) : 0
    const top = Math.round(Math.min(STRIP_HEIGHT * zoom, height))
    this.chrome.setBounds({ x: 0, y: 0, width, height })
    this.active.view.setBounds({ x: left, y: top, width: Math.max(0, width - left), height: Math.max(0, height - top) })
    // Adding a view that is already there moves it to the front.
    this.win.contentView.addChildView(this.overlay ? this.chrome : this.active.view)
  }

  private changed() {
    this.publish()
    this.onChange()
  }

  private publish() {
    if (this.chrome.webContents.isDestroyed()) return
    const contents = this.active.view.webContents
    const model = this.model()
    this.chrome.webContents.send('state', {
      tabs: model.strip,
      nodes: model.nodes,
      agents: model.agents,
      earlier: model.earlier,
      running: model.running,
      unread: model.unread,
      crumb: model.crumb,
      sidebar: this.sidebar.open,
      width: this.sidebar.width,
      dashboard: dashboardPage(this.dashboard.url),
      grouping: GROUPINGS.find((item) => item.value === this.sidebar.grouping)!.label,
      earlierOpen: this.sidebar.earlierOpen,
      activeId: this.activeId,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      external: !this.active.pinned,
      updateReady: this.updateReady,
      fullscreen: this.win.isFullScreen(),
    })
  }
}

function clampWidth(width: unknown): number {
  return typeof width === 'number' && Number.isFinite(width) ? Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width))) : SIDEBAR_WIDTH
}

function dashboardPage(url: string): DashboardPage {
  const view = URL.canParse(url) ? new URL(url).searchParams.get('view') : null
  return view === 'queue' || view === 'settings' ? view : 'list'
}

function readAgentState(file: string): AgentState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentState>
    if (typeof raw.since === 'string' && raw.seen && typeof raw.seen === 'object' && Array.isArray(raw.dismissed)) {
      return { since: raw.since, seen: raw.seen, dismissed: raw.dismissed.filter((key) => typeof key === 'string') }
    }
  } catch {
    // First launch, or a file that cannot be read.
  }
  // Agents that finished before the app first tracked them are not unread.
  const fresh: AgentState = { since: new Date().toISOString(), seen: {}, dismissed: [] }
  try {
    writeFileSync(file, JSON.stringify(fresh))
  } catch {
    // Kept in memory for this run.
  }
  return fresh
}
