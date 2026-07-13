// Focus Planner — Electron main process.
//
// Two windows:
//   1. The main planner window (loads the hosted web app).
//   2. A small, frameless, always-on-top "focus card" window that floats above
//      every other app — including fullscreen apps and other apps' windows — so
//      what-to-work-on-now is never covered. It loads the same app at "#focus".
//
// Loading the live deployment keeps the desktop app perfectly in sync with the
// web version and lets OAuth (Google, Zoho) work against the same backend.

const { app, BrowserWindow, shell, Menu, nativeImage, ipcMain, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// The web app to load. Override for local dev against a Vite server:
//   FOCUS_URL=http://localhost:5173 npm start
const APP_URL = process.env.FOCUS_URL || 'https://focus-planner-eight.vercel.app'
const APP_ORIGIN = (() => { try { return new URL(APP_URL).origin } catch { return null } })()
const FOCUS_URL = APP_URL + (APP_URL.includes('#') ? '' : '#focus')

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

// --- persisted focus-window bounds -----------------------------------------
const boundsFile = () => path.join(app.getPath('userData'), 'focus-bounds.json')
function loadFocusBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')) } catch { return null }
}
function saveFocusBounds(b) {
  try { fs.writeFileSync(boundsFile(), JSON.stringify(b)) } catch {}
}

let mainWindow = null
let focusWindow = null
let isQuitting = false

// A tiny offline page so a dropped connection shows a friendly retry instead of
// a blank window.
function offlineHtml(target) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html><head><meta charset="utf-8"><style>
      html,body{height:100%;margin:0;font:15px -apple-system,Segoe UI,Roboto,sans-serif;
        background:#0b1020;color:#e5e9f2;display:flex;align-items:center;justify-content:center}
      .box{text-align:center;padding:32px;max-width:340px}
      h1{font-size:18px;margin:0 0 8px}p{opacity:.75;margin:0 0 20px;line-height:1.5}
      button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:11px 20px;
        font-size:14px;font-weight:600;cursor:pointer}
    </style></head><body><div class="box">
      <h1>Can't reach Focus Planner</h1>
      <p>Check your internet connection and try again.</p>
      <button onclick="location.replace('${target}')">Retry</button>
    </div></body></html>`)
}

function attachLinkRouting(wc) {
  // New-window / target=_blank: keep our app and OAuth in-window; everything
  // else opens in the real browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) || isAuthUrl(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || isAuthUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
}

function createMainWindow() {
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

  win.webContents.setUserAgent(CHROME_UA)
  win.once('ready-to-show', () => win.show())
  win.loadURL(APP_URL)
  attachLinkRouting(win.webContents)
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(offlineHtml(APP_URL))
  })

  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
}

function createFocusWindow() {
  if (focusWindow && !focusWindow.isDestroyed()) { showFocusWindow(); return }

  const saved = loadFocusBounds()
  const work = screen.getPrimaryDisplay().workArea
  const w = saved?.width || 320
  const h = saved?.height || 300
  const x = saved?.x ?? work.x + work.width - w - 24
  const y = saved?.y ?? work.y + 24

  const win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    minWidth: 240,
    minHeight: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Float above EVERYTHING — including fullscreen apps and other apps' windows.
  // 'screen-saver' is the highest ordinary level; combined with
  // visibleOnFullScreen the card is never covered.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.once('ready-to-show', () => win.show())
  win.loadURL(FOCUS_URL)
  attachLinkRouting(win.webContents)
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(offlineHtml(FOCUS_URL))
  })

  const persist = () => { if (!win.isDestroyed()) saveFocusBounds(win.getBounds()) }
  win.on('moved', persist)
  win.on('resized', persist)

  // The X in the card hides the window (keeps it a click away) unless we're
  // actually quitting.
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide() }
  })
  win.on('closed', () => { if (focusWindow === win) focusWindow = null })

  focusWindow = win
}

function showFocusWindow() {
  if (!focusWindow || focusWindow.isDestroyed()) { createFocusWindow(); return }
  focusWindow.setAlwaysOnTop(true, 'screen-saver')
  focusWindow.showInactive()
}
function hideFocusWindow() {
  if (focusWindow && !focusWindow.isDestroyed()) focusWindow.hide()
}
function toggleFocusWindow() {
  if (focusWindow && !focusWindow.isDestroyed() && focusWindow.isVisible()) hideFocusWindow()
  else showFocusWindow()
}

ipcMain.on('focus:hide', hideFocusWindow)

// Native menu: standard shortcuts + a toggle for the floating focus card.
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
    {
      label: 'Window',
      submenu: [
        {
          label: 'Show Focus Card',
          accelerator: 'CommandOrControl+Shift+F',
          click: toggleFocusWindow,
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Single-instance: focus the existing window instead of opening a second app.
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
    createMainWindow()
    createFocusWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
        createFocusWindow()
      }
    })
  })

  app.on('before-quit', () => { isQuitting = true })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
