import { clipboard, ipcMain, Menu, shell, WebContentsView, type BaseWindow, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import path from 'node:path'

export const STRIP_HEIGHT = 40

type Tab = {
  id: number
  view: WebContentsView
  pinned: boolean
  title: string
  favicon: string | null
  loading: boolean
}

export type SavedTabs = { urls: string[]; active: number }

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
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
  onChange: () => void = () => {}
  onApplyUpdate: () => void = () => {}

  constructor(
    private readonly win: BaseWindow,
    private readonly session: Session,
    private readonly dashboardUrl: string,
  ) {
    this.chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.cjs') } })
    win.contentView.addChildView(this.chrome)
    void this.chrome.webContents.loadFile(path.join(__dirname, 'chrome', 'index.html'))

    ipcMain.on('chrome', (event, command: string, id?: number) => {
      if (event.sender !== this.chrome.webContents) return
      if (command === 'ready') this.publish()
      else if (command === 'select' && typeof id === 'number') this.activate(id)
      else if (command === 'close' && typeof id === 'number') this.close(id)
      else if (command === 'back') this.back()
      else if (command === 'forward') this.forward()
      else if (command === 'reload') this.reload()
      else if (command === 'open-external') this.openExternal()
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
    this.activate(dashboard.id)
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

  open(url: string, options: { background?: boolean; after?: Tab } = {}) {
    if (!isWebUrl(url)) return
    const tab = this.create(url, { after: options.after ?? this.active })
    if (!options.background) this.activate(tab.id)
    else this.changed()
  }

  async openFromClipboard() {
    const text = (await clipboard.readText()).trim()
    if (isWebUrl(text)) this.open(text)
    else shell.beep()
  }

  restore(saved: SavedTabs | null) {
    if (!saved) return
    for (const url of saved.urls) if (isWebUrl(url)) this.create(url, {})
    const target = this.tabs[saved.active]
    if (target) this.activate(target.id)
  }

  snapshot(): SavedTabs {
    return {
      urls: this.tabs.filter((tab) => !tab.pinned).map((tab) => tab.view.webContents.getURL()).filter(isWebUrl),
      active: this.tabs.indexOf(this.active),
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
    const index = (this.tabs.indexOf(this.active) + by + this.tabs.length) % this.tabs.length
    this.activate(this.tabs[index]!.id)
  }

  // Cmd+1 is the dashboard; Cmd+9 is the last tab, as in a browser.
  selectIndex(index: number) {
    const tab = index === 8 ? this.tabs.at(-1) : this.tabs[index]
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
    clipboard.writeText(this.active.view.webContents.getURL())
  }

  toggleDevTools() {
    this.active.view.webContents.toggleDevTools()
  }

  setUpdateReady(ready: boolean) {
    this.updateReady = ready
    this.publish()
  }

  private create(url: string, options: { pinned?: boolean; after?: Tab }): Tab {
    const view = new WebContentsView({ webPreferences: { session: this.session } })
    view.setBackgroundColor('#10110f')
    view.setVisible(false)
    const tab: Tab = { id: this.nextId++, view, pinned: options.pinned ?? false, title: options.pinned ? 'Pull requests' : url, favicon: null, loading: true }
    const at = options.after ? this.tabs.indexOf(options.after) + 1 : this.tabs.length
    this.tabs.splice(at, 0, tab)
    this.win.contentView.addChildView(view)
    this.wire(tab)
    void view.webContents.loadURL(url).catch(() => undefined)
    return tab
  }

  private wire(tab: Tab) {
    const contents = tab.view.webContents
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // A script-opened popup (a sign-in window, say) needs to stay a real
      // window so it can talk to the page that opened it.
      if (disposition === 'new-window') return { action: 'allow' }
      this.open(url, { background: disposition === 'background-tab', after: tab })
      return { action: 'deny' }
    })
    if (tab.pinned) {
      contents.on('will-navigate', (event) => {
        if (new URL(event.url).origin === new URL(this.dashboardUrl).origin) return
        event.preventDefault()
        this.open(event.url, { after: tab })
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
      this.publish()
    })
    contents.on('did-navigate', () => this.changed())
    contents.on('did-navigate-in-page', () => this.changed())
    contents.on('context-menu', (_event, params) => this.contextMenu(contents, params))
  }

  private contextMenu(contents: WebContents, params: Electron.ContextMenuParams) {
    const items: MenuItemConstructorOptions[] = []
    if (isWebUrl(params.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.open(params.linkURL, { background: true }) },
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
    this.activeId = id
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
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    if (this.activeId === id) this.activate((this.tabs[index] ?? this.tabs[index - 1])!.id)
    else this.changed()
  }

  private layout() {
    const { width, height } = this.win.getContentBounds()
    this.chrome.setBounds({ x: 0, y: 0, width, height: STRIP_HEIGHT })
    this.active.view.setBounds({ x: 0, y: STRIP_HEIGHT, width, height: Math.max(0, height - STRIP_HEIGHT) })
  }

  private changed() {
    this.publish()
    this.onChange()
  }

  private publish() {
    if (this.chrome.webContents.isDestroyed()) return
    const contents = this.active.view.webContents
    this.chrome.webContents.send('state', {
      tabs: this.tabs.map(({ id, pinned, title, favicon, loading }) => ({ id, pinned, title, favicon, loading })),
      activeId: this.activeId,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      external: !this.active.pinned,
      updateReady: this.updateReady,
      fullscreen: this.win.isFullScreen(),
    })
  }
}
