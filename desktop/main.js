// Focus Planner — Electron main process.
//
// This is a thin native shell around the hosted web app. It loads the live
// deployment so the desktop app stays perfectly in sync with the web version
// and OAuth (Google, Zoho) keeps working against the same backend. External
// links and OAuth pop-ups are routed to the user's real browser where needed,
// and everything else stays inside the app window.

const { app, BrowserWindow, shell, Menu, nativeImage } = require('electron')
const path = require('node:path')

// The web app to load. Override for local dev against a Vite server:
//   FOCUS_URL=http://localhost:5173 npm start
const APP_URL = process.env.FOCUS_URL || 'https://focus-planner-eight.vercel.app'
const APP_ORIGIN = (() => { try { return new URL(APP_URL).origin } catch { return null } })()

// A modern Chrome UA. Google blocks OAuth inside "embedded webviews"; presenting
// as a normal Chrome browser lets the in-window sign-in flow succeed.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Hosts that are part of a sign-in flow and must stay in-window so the session
// cookie lands on our own origin when the round-trip completes.
const AUTH_HOSTS = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'content.googleapis.com',
  'accounts.zoho.com',
  'accounts.zoho.eu',
  'accounts.zoho.in',
  'accounts.zoho.com.au',
]

function isAppUrl(u) {
  try { return APP_ORIGIN && new URL(u).origin === APP_ORIGIN } catch { return false }
}
function isAuthUrl(u) {
  try { return AUTH_HOSTS.includes(new URL(u).hostname) } catch { return false }
}

let mainWindow = null

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1020',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Present as Chrome so Google's OAuth doesn't reject us as an embedded webview.
  win.webContents.setUserAgent(CHROME_UA)

  win.once('ready-to-show', () => win.show())
  win.loadURL(APP_URL)

  // Where new-window / target=_blank requests go. Keep our own app and the
  // OAuth providers in-window; send everything else to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) || isAuthUrl(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Full-page navigations: allow our origin and the auth round-trip; anything
  // else (a plain external link the app navigates to) opens in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || isAuthUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
}

// A minimal, native menu so standard shortcuts (copy/paste, reload, zoom,
// devtools, quit) work as users expect.
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Single-instance: focus the existing window instead of opening a second one.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
