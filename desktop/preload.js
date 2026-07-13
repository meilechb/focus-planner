// Preload runs in an isolated context before the page loads. We keep the
// surface minimal — no Node APIs are exposed to the web app — just a flag the
// web app uses to know it's running inside the desktop shell, and a call the
// floating focus card uses to hide its own window.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focusDesktop', {
  isDesktop: true,
  platform: process.platform,
  hideFocusCard: () => ipcRenderer.send('focus:hide'),
})
