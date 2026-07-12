// Preload runs in an isolated context before the page loads. We keep the
// surface minimal — no Node APIs are exposed to the web app — but this is the
// place to add a small, audited bridge later if the desktop app ever needs
// native features (notifications, deep links, etc.).
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('focusDesktop', {
  isDesktop: true,
  platform: process.platform,
})
