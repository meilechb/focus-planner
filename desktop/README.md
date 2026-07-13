# Focus Planner — Desktop app

A native desktop window for Focus Planner, built with [Electron](https://www.electronjs.org/).
It's a thin shell around the hosted web app: it loads your live deployment, so
the desktop app is always identical to the web version and OAuth (Google, Zoho)
keeps working against the same backend — nothing to re-configure.

What you get over a browser tab:

- **A floating, always-on-top focus card.** A small window that shows what to
  work on right now and floats above every other app — including fullscreen
  apps and other windows — so it's never covered. Drag it anywhere by its
  header; it remembers where you put it. Hide it with its ✕, and bring it back
  from **Window → Show Focus Card** (⌘/Ctrl+Shift+F).
- Its own app icon in the Dock / Taskbar / Start menu.
- A dedicated window with no browser chrome, native menus, and standard
  shortcuts (⌘R reload, ⌘+/− zoom, fullscreen, etc.).
- Single-instance behaviour — clicking the icon focuses the existing window.
- External links open in your real browser; sign-in flows stay in-window.
- A friendly retry screen if the connection drops, instead of a blank window.

### How the floating focus card stays in sync

The focus card is a second, frameless, always-on-top window that loads the same
app at `#focus`. It shares the main window's local cache, so it always reflects
your current schedule: change a block in the planner and the floating card
updates within moments. Checking a task off on the card syncs it back too.

## Run it locally (development)

```bash
cd desktop
npm install
npm start
```

To point the app at a local dev server instead of the live site:

```bash
FOCUS_URL=http://localhost:5173 npm start
```

## Build installers

Build for your current platform:

```bash
cd desktop
npm install
npm run dist          # current OS
# or target one explicitly:
npm run dist:mac      # .dmg + .zip  (run on macOS)
npm run dist:win      # .exe (NSIS)  (run on Windows)
npm run dist:linux    # .AppImage    (run on Linux)
```

Finished installers land in `desktop/dist/`.

> Each platform's installer must be built on that platform (macOS builds Mac
> apps, Windows builds Windows apps, and so on). The easiest way to get all
> three at once is the CI workflow below.

## Build all three with CI (recommended)

A GitHub Actions workflow (`.github/workflows/desktop.yml`) builds Mac, Windows,
and Linux apps on their native runners automatically.

- **Manual:** GitHub → **Actions** → **Build desktop apps** → **Run workflow**.
  Download the installers from the run's **Artifacts** section when it finishes.
- **Tagged release:** push a tag like `desktop-v1.0.0` and the same build runs,
  then attaches all installers to a GitHub Release:

  ```bash
  git tag desktop-v1.0.0
  git push origin desktop-v1.0.0
  ```

## Notes

- **Code signing:** CI builds are unsigned, so on first launch macOS/Windows may
  warn about an "unidentified developer." That's expected. To ship signed builds,
  add signing certificates as repository secrets and remove
  `CSC_IDENTITY_AUTO_DISCOVERY: false` from the workflow.
- **App URL:** the default deployment URL lives in `desktop/main.js` (`APP_URL`).
  Update it there if the hosted app moves.
- **Icon:** `desktop/build/icon.png` (1024×1024) is the source icon;
  electron-builder generates the per-platform icon formats from it.
