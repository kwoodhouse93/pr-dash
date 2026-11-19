import { contextBridge, ipcRenderer } from 'electron'

const commands = new Set(['select', 'close', 'back', 'forward', 'reload', 'open-external', 'apply-update'])

contextBridge.exposeInMainWorld('shell', {
  send(command: string, id?: number) {
    if (commands.has(command)) ipcRenderer.send('chrome', command, id)
  },
  onState(listener: (state: unknown) => void) {
    ipcRenderer.on('state', (_event, state) => listener(state))
    ipcRenderer.send('chrome', 'ready')
  },
})
