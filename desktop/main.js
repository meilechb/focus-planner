// Focus Planner — Windows desktop shell (Electron).
//
// Two windows:
//   1. Main planner window — loads the hosted web app.
//   2. A small always-on-top "focus card" that floats above everything. It's a
//      frameless transparent window; dragging and resizing are done manually
//      via IPC (native resize is unreliable on transparent Windows windows),
//      driven by pointer events in the web #focus view.
//
// Closing the main window quits the whole app (card included) so no invisible
// process is ever left behind — which is what stopped it reopening before.

const { app, BrowserWindow, shell, ipcMain, screen, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const APP_URL = process.env.FOCUS_URL || 'https://focus-planner-eight.vercel.app'
const APP_ORIGIN = (() => { try { return new URL(APP_URL).origin } catch { return null } })()
const FOCUS_URL = APP_URL + (APP_URL.includes('#') ? '' : '#focus')

// Present as Chrome so Google's OAuth doesn't reject us as an "embedded webview".
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const AUTH_HOSTS = ['accounts.google.com', 'oauth2.googleapis.com', 'content.googleapis.com',
  'accounts.zoho.com', 'accounts.zoho.eu', 'accounts.zoho.in', 'accounts.zoho.com.au']
const isAppUrl = (u) => { try { return APP_ORIGIN && new URL(u).origin === APP_ORIGIN } catch { return false } }
const isAuthUrl = (u) => { try { return AUTH_HOSTS.includes(new URL(u).hostname) } catch { return false } }

const CARD = { minW: 220, minH: 120, maxW: 520, maxH: 360, defW: 300, defH: 210 }
const boundsFile = () => path.join(app.getPath('userData'), 'focus-card-bounds.json')
const loadBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')) } catch { return null } }
const saveBounds = (b) => { try { fs.writeFileSync(boundsFile(), JSON.stringify(b)) } catch {} }

let mainWindow = null
let cardWindow = null

function offlineHtml(target) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;font:15px Segoe UI,system-ui,sans-serif;background:#0f0e17;color:#e8e8f2;
    display:flex;align-items:center;justify-content:center}.b{text-align:center;padding:32px;max-width:340px}
    h1{font-size:18px;margin:0 0 8px}p{opacity:.75;margin:0 0 20px;line-height:1.5}
    button{background:#6d5efc;color:#fff;border:0;border-radius:10px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer}
    </style></head><body><div class="b"><h1>Can't reach Focus Planner</h1>
    <p>Check your internet connection and try again.</p>
    <button onclick="location.replace('${target}')">Retry</button></div></body></html>`)
}

function routeLinks(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) || isAuthUrl(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url) || isAuthUrl(url)) return
    e.preventDefault(); shell.openExternal(url)
  })
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 940, minHeight: 620,
    backgroundColor: '#ffffff',
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  win.webContents.setUserAgent(CHROME_UA)
  win.loadURL(APP_URL)
  routeLinks(win.webContents)
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(offlineHtml(APP_URL))
  })
  // Closing the planner quits everything — no leftover background process.
  win.on('closed', () => {
    mainWindow = null
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.destroy()
    app.quit()
  })
  mainWindow = win
}

function createCardWindow() {
  const work = screen.getPrimaryDisplay().workArea
  const saved = loadBounds()
  const w = saved?.width || CARD.defW
  const h = saved?.height || CARD.defH
  const x = saved?.x ?? work.x + work.width - w - 24
  const y = saved?.y ?? work.y + work.height - h - 24

  const win = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, transparent: true, resizable: false, thickFrame: false,
    maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setUserAgent(CHROME_UA)
  win.loadURL(FOCUS_URL)
  routeLinks(win.webContents)
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(offlineHtml(FOCUS_URL))
  })
  win.on('closed', () => { cardWindow = null })
  cardWindow = win
}

// ---- IPC: manual drag / resize / visibility for the card ------------------
ipcMain.on('card:move', (_e, { dx, dy }) => {
  if (!cardWindow || cardWindow.isDestroyed()) return
  const [x, y] = cardWindow.getPosition()
  cardWindow.setPosition(Math.round(x + dx), Math.round(y + dy))
  const b = cardWindow.getBounds(); saveBounds(b)
})
ipcMain.on('card:resize', (_e, { width, height }) => {
  if (!cardWindow || cardWindow.isDestroyed()) return
  const w = Math.max(CARD.minW, Math.min(CARD.maxW, Math.round(width)))
  const h = Math.max(CARD.minH, Math.min(CARD.maxH, Math.round(height)))
  const [x, y] = cardWindow.getPosition()
  cardWindow.setBounds({ x, y, width: w, height: h })
  saveBounds({ x, y, width: w, height: h })
})
ipcMain.on('card:hide', () => { if (cardWindow && !cardWindow.isDestroyed()) cardWindow.hide() })
ipcMain.on('app:focusMain', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
})

// Single instance: relaunching focuses/reshows the running app instead of
// spawning a second one (and recovers it if it was hidden).
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show(); mainWindow.focus()
    if (!cardWindow || cardWindow.isDestroyed()) createCardWindow()
    else cardWindow.show()
  })

  app.whenReady().then(() => {
    createMainWindow()
    try { createCardWindow() } catch (e) { console.error('card window failed:', e) }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
        try { createCardWindow() } catch (e) { console.error('card window failed:', e) }
      }
    })
  })

  app.on('window-all-closed', () => app.quit())
}
