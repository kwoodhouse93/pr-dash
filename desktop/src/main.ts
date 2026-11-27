import { app, BaseWindow, dialog, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../../src/server/env.ts'
import { pickPayload, readPayload, type Payload } from './payload.ts'
import { serverOrigin, startServer, stopServer, type ServerOptions } from './server.ts'
import { adoptShellPath } from './shell-env.ts'
import { themeOf } from '../../src/shared/themes.ts'
import { Tabs, type SavedTabs, type SidebarState } from './tabs.ts'
import { Updater } from './updater.ts'

const UPDATE_INTERVAL_MS = 5 * 60_000

// Electron would name the folder after the package, "pr-dash-desktop". Both
// overrides exist so a development run can stay clear of the installed app.
app.setName('PR Dash')
app.setPath('userData', process.env.PR_DASH_USER_DATA ? path.resolve(process.env.PR_DASH_USER_DATA) : path.join(app.getPath('appData'), 'PR Dash'))
const userData = app.getPath('userData')
mkdirSync(userData, { recursive: true })

// The dashboard keeps its preferences per origin, so the port must not change
// between launches. 4317 is left for `npm run dev`.
const serverOptions: ServerOptions = {
  port: Number(process.env.PR_DASH_PORT ?? 4318),
  databasePath: path.join(userData, 'data', 'pr-dash.sqlite'),
  logFile: path.join(userData, 'server.log'),
}
const windowFile = path.join(userData, 'window.json')

type WindowState = { bounds?: Electron.Rectangle; tabs?: SavedTabs; sidebar?: Partial<SidebarState>; theme?: string }

let win: BaseWindow | null = null
let tabs: Tabs | null = null
let running: Payload | null = null
let pending: Payload | null = null
let applying = false
const updater = new Updater(path.join(userData, 'payload'))

if (!app.requestSingleInstanceLock()) app.quit()
else void main()

async function main() {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    saveWindow()
    void stopServer()
  })

  await app.whenReady()
  adoptShellPath()
  // Keys live in a .env beside the database, read the way the server reads one.
  process.chdir(userData)
  loadEnv()

  const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.resolve(__dirname, '../../dist/payload')
  const payload = pickPayload(readPayload(bundledDir), updater.downloaded())
  if (!payload) return fail('This build has no dashboard payload. Run `npm run build:payload` and rebuild the app.')
  mkdirSync(path.dirname(serverOptions.databasePath), { recursive: true })
  try {
    await startServer(payload, serverOptions)
  } catch (error) {
    return fail(`${messageOf(error)}\n\nThe server log is at ${serverOptions.logFile}.`)
  }
  running = payload
  updater.prune(payload)

  openWindow()
  buildMenu()
  void checkForUpdate()
  setInterval(() => void checkForUpdate(), UPDATE_INTERVAL_MS)
}

function openWindow() {
  const saved = readWindow()
  // Sites such as Google refuse to sign in to anything that names itself as an
  // embedded browser, so present the plain Chrome this is built on.
  const pages = session.fromPartition('persist:pr-dash')
  pages.setUserAgent(app.userAgentFallback.replace(/(\(KHTML, like Gecko\) ).*?(Chrome\/\S+).*?(Safari\/\S+)/, '$1$2 $3'))
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'])
  pages.setPermissionRequestHandler((_contents, permission, done) => done(allowed.has(permission)))

  win = new BaseWindow({
    width: 1440,
    height: 900,
    ...saved.bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'PR Dash',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: themeOf(saved.theme).bg,
  })
  tabs = new Tabs(win, pages, serverOrigin(serverOptions), { sidebar: saved.sidebar, agentFile: path.join(userData, 'agents.json'), theme: saved.theme })
  tabs.restore(saved.tabs ?? null)
  let saveTimer: NodeJS.Timeout | null = null
  tabs.onChange = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveWindow, 1000)
    // Leaving the dashboard tab is a safe moment to restart what serves it.
    void applyWhenUnwatched()
  }
  tabs.onApplyUpdate = () => void applyUpdate()
  win.on('blur', () => void applyWhenUnwatched())
  win.on('close', saveWindow)
}

function readWindow(): WindowState {
  try {
    return JSON.parse(readFileSync(windowFile, 'utf8')) as WindowState
  } catch {
    return {}
  }
}

function saveWindow() {
  if (!win || win.isDestroyed() || !tabs) return
  const state: WindowState = { bounds: win.getNormalBounds(), tabs: tabs.snapshot(), sidebar: tabs.sidebarState, theme: tabs.themeId }
  writeFileSync(windowFile, JSON.stringify(state))
}

async function checkForUpdate(announce = false) {
  if (!running || applying) return
  try {
    const found = await updater.fetchNewer(pending ?? running)
    if (found) {
      pending = found
      await applyWhenUnwatched()
    }
    if (announce && !found && win) {
      const detail = pending
        ? 'An update is downloaded and waiting. Use the Update button at the top of the window.'
        : `Build ${running.sha.slice(0, 7)} is the latest.`
      void dialog.showMessageBox(win, { message: pending ? 'Update ready' : 'Up to date', detail })
    }
  } catch (error) {
    console.error('update check failed:', messageOf(error))
    if (announce && win) void dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates', detail: messageOf(error) })
  }
}

// An update restarts the server and reloads the dashboard, which would throw
// away a reply being typed. Do it unprompted only while nobody is looking at
// the dashboard; otherwise offer a button.
async function applyWhenUnwatched() {
  if (!pending || !win || !tabs) return
  if (win.isFocused() && tabs.dashboardActive) tabs.setUpdateReady(true)
  else await applyUpdate()
}

async function applyUpdate() {
  if (!pending || !running || applying) return
  applying = true
  const next = pending
  const previous = running
  pending = null
  try {
    await stopServer()
    try {
      await startServer(next, serverOptions)
      running = next
    } catch (error) {
      console.error('update failed to start:', messageOf(error))
      updater.reject(previous)
      await startServer(previous, serverOptions)
    }
    updater.prune(running)
    tabs?.setUpdateReady(false)
    tabs?.reloadDashboard()
    buildMenu()
  } catch (error) {
    fail(`The server could not be restarted: ${messageOf(error)}`)
  } finally {
    applying = false
  }
}

function buildMenu() {
  const t = () => tabs
  const tabNumbers: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_unused, index) => ({
    label: index === 0 ? 'Dashboard' : index === 8 ? 'Last Tab' : `Tab ${index + 1}`,
    accelerator: `Cmd+${index + 1}`,
    visible: index === 0,
    acceleratorWorksWhenHidden: true,
    click: () => t()?.selectIndex(index),
  }))
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: `Build ${running?.sha.slice(0, 7) ?? 'unknown'}`, enabled: false },
        { label: 'Check for Updates…', click: () => void checkForUpdate(true) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Cmd+R', click: () => t()?.reload() },
        { label: 'Back', accelerator: 'Cmd+[', click: () => t()?.back() },
        { label: 'Forward', accelerator: 'Cmd+]', click: () => t()?.forward() },
        { type: 'separator' },
        { label: 'Show or Hide Sidebar', accelerator: 'Ctrl+Cmd+S', click: () => t()?.toggleSidebar() },
        { label: 'Open in Browser', accelerator: 'Shift+Cmd+O', click: () => t()?.openExternal() },
        { label: 'Copy Link', accelerator: 'Shift+Cmd+C', click: () => t()?.copyLink() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: () => t()?.zoom(null) },
        { label: 'Zoom In', accelerator: 'Cmd+Plus', click: () => t()?.zoom(0.5) },
        { label: 'Zoom In', accelerator: 'Cmd+=', visible: false, acceleratorWorksWhenHidden: true, click: () => t()?.zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: () => t()?.zoom(-0.5) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+Cmd+I', click: () => t()?.toggleDevTools() },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'New Tab from Clipboard', accelerator: 'Cmd+T', click: () => void t()?.openFromClipboard() },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: () => t()?.closeActive() },
        { label: 'Reopen Closed Tab', accelerator: 'Shift+Cmd+T', click: () => t()?.reopenClosed() },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => t()?.step(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => t()?.step(-1) },
        { type: 'separator' },
        ...tabNumbers,
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function fail(message: string) {
  dialog.showErrorBox('PR Dash', message)
  app.quit()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
