import { contextBridge, ipcRenderer } from 'electron'

const commands = new Set([
  'select',
  'close',
  'back',
  'forward',
  'reload',
  'open-external',
  'copy-link',
  'tab-menu',
  'apply-update',
  'toggle-sidebar',
  'grouping-menu',
  'toggle-group',
  'toggle-earlier',
  'agent-open',
  'agent-dismiss',
  'agents-clear',
  'overlay',
  'flight-target',
  'sidebar-width',
  'dashboard',
])

contextBridge.exposeInMainWorld('shell', {
  send(command: string, arg?: number | string | boolean) {
    if (commands.has(command)) ipcRenderer.send('chrome', command, arg)
  },
  onFlight(listener: (flight: unknown) => void) {
    ipcRenderer.on('flight', (_event, flight) => listener(flight))
  },
  onState(listener: (state: unknown) => void) {
    ipcRenderer.on('state', (_event, state) => listener(state))
    ipcRenderer.send('chrome', 'ready')
  },
})
