// Minimal, audited bridge — no Node access leaks to the web app. Exposes the
// desktop flag and the manual drag/resize/visibility calls the floating focus
// card uses (native drag/resize is unreliable on transparent Windows windows).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focusDesktop', {
  isDesktop: true,
  platform: process.platform,
  moveCard: (dx, dy) => ipcRenderer.send('card:move', { dx, dy }),
  resizeCard: (width, height) => ipcRenderer.send('card:resize', { width, height }),
  hideFocusCard: () => ipcRenderer.send('card:hide'),
  focusMain: () => ipcRenderer.send('app:focusMain'),
})
