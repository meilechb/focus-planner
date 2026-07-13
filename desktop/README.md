# Focus Planner — Windows desktop app

A native Windows window for Focus Planner, built with [Electron](https://www.electronjs.org/).
It loads the live web app, so it always matches the website and OAuth (Google,
Zoho) keeps working against the same backend.

Two windows:

- **Planner** — the full app in its own window. Closing it quits the app.
- **Floating focus card** — a small always-on-top card showing what to work on
  now. **Drag it anywhere** (click and drag the card), **resize** from the
  bottom-right corner, hide it with ✕, and open the planner from its button.

## Run locally (development)

```bash
cd desktop
npm install
npm start
```

Point at a local dev server instead of the live site:

```bash
set FOCUS_URL=http://localhost:5173 && npm start
```

## Build the installer

```bash
cd desktop
npm install
npm run dist
```

The installer lands in `desktop/dist/Focus Planner-<version>-win-x64.exe`.

## CI build (recommended)

`.github/workflows/desktop.yml` builds the Windows installer on a Windows
runner and attaches it to the **desktop-latest** GitHub Release. Trigger it by
pushing to the working branch, pushing a `desktop-v*` tag, or **Actions → Build
desktop apps → Run workflow**.

## Notes

- The build is unsigned, so first launch may show a Windows SmartScreen prompt:
  **More info → Run anyway**.
- The deployment URL lives in `desktop/main.js` (`APP_URL`).
