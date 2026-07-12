# Focus Planner — Build Specification

**For: Claude Code**
**Owner: Meilech Biller**
**Status: greenfield rebuild. Built fresh in a Git repo the owner controls.**

> **Revision note (this version).** This spec incorporates four corrections found in review, each marked **[REV]** where it appears:
> 1. Refresh tokens are stored in **private** Vercel Blob and **encrypted at rest** (was: default Blob, publicly guessable URL).
> 2. **Timezone handling is now explicit** — all "minutes from midnight" math goes through one timezone-aware helper (was: unspecified; would break because serverless runs in UTC).
> 3. `POST /api/data` writes are **serialized with read-verify-retry** to prevent a read-modify-write race that silently clobbers data (was: naive read→patch→write).
> 4. Zoho uses a **"Server-based Application"** OAuth client, not a "Self Client" (a Self Client has no redirect URI and cannot do the redirect flow this app uses).
>
> Smaller corrections folded in: Calendar `events` uses `singleEvents=true`; Google Tasks completion write-back sets/clears the `completed` field correctly; the session cookie carries a signed expiry checked server-side; `vercel.json` includes an SPA rewrite.

---

## 0. Read this first — why this document exists

A previous attempt built this app inside a chat window. The code was correct but it lived nowhere the owner could edit it, so every small change meant regenerating the whole project and hand-shipping a zip. That is unacceptable and is the specific problem this setup solves.

**The core requirement of this project, above any feature: the code must live in a Git repo on the owner's machine, and Claude Code must edit files in place, commit, and push. Vercel auto-deploys on push. There is never a zip, never a download, never a copy-paste of source.**

If any instruction below conflicts with that principle, that principle wins.

---

## 1. What the app is

A personal time-blocking planner for one person (the owner). Not a product, not multi-tenant. One user, one account, private.

**The daily ritual it supports:** Each morning the owner opens the planner and plans that day from scratch. They see their real Google Calendar meetings already on the grid. They see their open tasks (Google Tasks + Zoho) in a sidebar. They drag projects and tasks onto a day grid to block out time. Then a small always-visible card shows what they should be focused on *right now*, with a checklist of the tasks in the current block, which they tick off as they go.

**It is a planning tool, not a calendar.** It reads the calendar; it does not write to it.

---

## 2. Locked design decisions — do not revisit these

These were decided with the owner and are final. Do not "improve" them.

1. **Plan each day fresh.** Blocks are keyed by ISO date (`"2026-07-12"`). Nothing recurs. Yesterday's plan does not carry forward.
2. **Google Calendar is READ-ONLY.** Never create, edit, or delete calendar events.
3. **Google Tasks is READ/WRITE.** Ticking a task in the planner must mark it complete in Google Tasks.
4. **Visual = Google Calendar clone, light theme.** Solid fully-colored event blocks with white text. Hairline hour grid. Red "now" line. Blue accent `#1A73E8`. Material-style underline inputs in modals. Pill toolbar with Today + ‹ › nav + Day/Week toggle. The owner explicitly approved this look. Match it.
5. **The focus card is ONE solid color fill with white text.** Not a gradient, not a bordered card.
6. **Day-view blocks support BOTH resize (drag the edge = change duration) AND free-drag (move = change time).**
7. **The "Next" button leaves the current block's tasks untouched.** It jumps focus to the next block. It does NOT auto-complete anything.
8. **Zero cost.** Free tiers only.

---

## 3. Architecture

### Stack

- **Frontend:** Vite + React (plain SPA, not Next.js)
- **Backend:** Vercel serverless functions in `/api/*`
- **Storage:** Vercel Blob (**private store**) — a single encrypted JSON document
- **Auth:** single shared passphrase → signed HMAC session cookie (with server-checked expiry)
- **Hosting:** Vercel, Hobby (free) tier
- **Source control:** GitHub, with Vercel auto-deploy on push to `main`

### Why this storage choice (context so nobody second-guesses it)

Supabase was the original choice and had to be abandoned: the owner's Supabase account is capped at **2 active projects account-wide** (a new organization does NOT bypass this — it counts across every org where they are owner/admin), and both slots hold real projects that must not be touched:

- `pointpilot` (project id `qlghqnkbkjzzdjlpccyr`) — PointTripper, 18 tables, live
- `Deliverability Dashboard` (project id `vkwyhaudvygxgoytjqam`) — live

**Do not create, pause, delete, or write to any Supabase project.**

Vercel Blob was chosen because it is free on Hobby, has no project cap, and is provisioned inside the same Vercel project already being deployed to. The data is tiny and single-user, so one JSON document is more than sufficient.

### [REV] Blob privacy and secret-at-rest — non-negotiable

The single JSON document contains OAuth `refresh_token`s, which are secrets.

- **Use a PRIVATE Blob store**, not the default public one. Default Blob (`addRandomSuffix: false`) produces a *predictable, publicly fetchable* URL like `https://<store>.public.blob.vercel-storage.com/focus/data.json` — anyone who guesses the path reads the tokens. Private storage serves URLs at `https://<store-id>.private.blob.vercel-storage.com/<pathname>` that are **not** publicly accessible and require the store token (which lives only in serverless env vars).
- **Additionally encrypt `refresh_token` at rest** with AES-256-GCM keyed from `SESSION_SECRET`, so even a leaked blob does not expose usable tokens. Encrypt on `saveConnection`, decrypt only inside `google.js` / `zoho.js` when minting an access token. The plaintext token never leaves the server and is never written unencrypted.

### Vercel Hobby constraints you must respect

- **Max 12 serverless functions.** Files whose names start with `_` are NOT counted as functions — this is why shared helper code lives in `api/_lib/`. Keep it that way.
- Function timeout: set `maxDuration: 30` in `vercel.json` (Hobby ceiling is 60s).
- Current design uses **9 functions**, leaving headroom.

### [REV] `vercel.json`

The SPA needs deep links / refresh to serve `index.html` while `/api/*` still routes to functions:

```json
{
  "functions": { "api/**/*.js": { "maxDuration": 30 } },
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

### Data model — the entire Blob document

One JSON file at Blob pathname `focus/data.json` (in the **private** store). `refresh_token` values are stored **encrypted** (shown here as plaintext for clarity only):

```json
{
  "state": {
    "timezone": "America/New_York",
    "projects": [
      { "id": "uuid", "name": "Client work", "color": "#0B8043", "note": "shows on the focus card" }
    ],
    "blocks": {
      "2026-07-12": [
        {
          "id": "uuid",
          "start": 540,
          "end": 600,
          "projectId": "uuid"
        },
        {
          "id": "uuid",
          "start": 600,
          "end": 690,
          "title": "Inbox + follow-ups",
          "color": "#039BE5",
          "tasks": [
            { "id": "googleTaskId", "listId": "googleListId", "connId": "connectionUuid", "title": "Reply to Sarah", "status": "needsAction" }
          ]
        }
      ]
    },
    "selectedCalendars": ["connId::calendarId"],
    "selectedTaskLists": ["connId::taskListId"],
    "selectedZoho": []
  },
  "connections": [
    {
      "id": "uuid",
      "provider": "google",
      "account_email": "me@example.com",
      "account_label": "me@example.com",
      "refresh_token": "ENCRYPTED",
      "extra": {}
    },
    {
      "id": "uuid",
      "provider": "zoho",
      "account_email": null,
      "account_label": "Zoho",
      "refresh_token": "ENCRYPTED",
      "extra": { "api_domain": "https://www.zohoapis.com" }
    }
  ]
}
```

**Key facts about this model:**

- `start` / `end` are **minutes from midnight** (integers), **in the owner's timezone** (see the timezone section). 9:00am local = 540.
- `state.timezone` is the owner's IANA zone. Single user, so it may be hardcoded to `America/New_York` to start; keeping it in state leaves room to change it without a code edit.
- A block is EITHER a **project block** (has `projectId`) OR a **task block** (has `tasks[]`, and optionally `title` and `color`). Never both.
- Task blocks can hold **multiple tasks** — this is the multi-task checklist feature.
- The composite key format `"connId::calendarId"` exists to support **multiple Google accounts**. Never collapse it to a bare id.
- `refresh_token` is a secret. **It must never be sent to the browser** and is stored encrypted. The `/api/connections` endpoint strips it entirely.

### [REV] Timezone handling — decide once, apply everywhere

Vercel serverless functions run in **UTC**. Google Calendar events arrive as timezone-aware RFC3339 timestamps. If event times are converted to minutes-from-midnight with a naive `getHours()`, meetings land on the grid at the wrong hour (off by the UTC offset). To prevent this:

- A single helper, `toLocalMinutes(isoOrDate, tz)`, converts any instant to minutes-from-midnight **in `tz`** (implement with `Intl.DateTimeFormat(…, { timeZone: tz, hour, minute, hour12:false })`, or a small date lib). This is the ONLY place instant→minutes conversion happens.
- The `events` action converts each event's start/end through `toLocalMinutes` using `state.timezone`.
- The client live clock (`nowMinutes()`) computes "now" in the **same** `tz`, not the browser's raw local time, so the red now-line and the focus card agree with the grid.
- `buffersFrom(meetings)` and `computeFocus(...)` operate on already-converted minute values, so they are timezone-agnostic by construction.

### Auth design (deliberately simple)

Not a real auth system, and it doesn't need to be — one user, private app.

- Owner sets `APP_PASSPHRASE` in Vercel env vars.
- `POST /api/login` with `{ passphrase }` → compares constant-time against `APP_PASSPHRASE` → on success sets cookie `focus_session`, HttpOnly, Secure, SameSite=Lax, 60-day expiry.
- **[REV] The cookie carries a server-checkable expiry.** Value format: `owner.<exp>.<HMAC-SHA256("owner."+exp, SESSION_SECRET)>`, where `exp` is a unix-seconds expiry 60 days out. `requireUser(req)` verifies the HMAC **and** that `exp` is in the future (both constant-time where it matters). This makes the 60-day expiry mean something server-side, not just as a client cookie attribute.
- Every protected endpoint calls `requireUser(req)` which validates that cookie (or the same value passed as `Authorization: Bearer`, as a fallback for any cookie weirdness).
- `GET /api/login` → `{ authed: true|false }`, used by the frontend on load to decide login screen vs planner.
- `POST /api/login?action=logout` → clears cookie.

**Important:** login is deliberately **separate** from Google/Zoho access. Do not try to use a Google login as the app's auth. Google API access is handled by stored refresh tokens (below), because OAuth access tokens expire hourly and would break calendar sync, and because we need to support multiple Google accounts simultaneously.

### OAuth design (Google + Zoho)

Both follow the identical pattern:

1. `GET /api/{provider}/start` → verifies session → returns `{ url }` for the provider's consent screen. The `state` param is an HMAC-signed payload (signed with `SESSION_SECRET`) so the callback can trust it.
2. Browser goes to provider, user consents.
3. Provider redirects to `GET /api/{provider}/callback?code=...&state=...`
4. Callback verifies `state`, exchanges `code` for tokens, and **stores the `refresh_token` (encrypted)** in the Blob doc's `connections[]`. Redirects back to `/?connected={provider}&status=ok`.
5. Thereafter, any time we need to call the provider's API, we mint a fresh **access token** from the stored **refresh token**, on demand, server-side.

Google specifics:

- Must use a **"Web application"** OAuth client type (NOT "Desktop"). The old desktop version used a Desktop client; that will not work here.
- Auth URL params must include `access_type=offline` and `prompt=consent` — without these Google does not return a `refresh_token`.
- Scopes: `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/tasks`, plus `openid email profile` (to label the account).
- Enable both **Google Calendar API** and **Google Tasks API** in the Cloud project.
- Redirect URI: `https://<LIVE-URL>/api/google/callback`

Zoho specifics:

- **[REV] Register a "Server-based Applications" client in the Zoho API console — NOT a "Self Client."** A Self Client has no redirect URI and is only for headless backend jobs with no user interaction; this app uses an authorization-code **redirect** flow, which requires the Server-based type. The Server-based client is where the redirect URI and client id/secret are configured.
- Zoho is per-datacenter. Default accounts domain `https://accounts.zoho.com`, but **store the `api_domain` returned at token exchange** and use it for all subsequent API calls.
- Scopes: `ZohoProjects.projects.READ,ZohoProjects.tasks.READ,ZohoCRM.modules.READ,ZohoCRM.settings.READ,AaaServer.profile.READ`
- Auth URL params must include `access_type=offline` and `prompt=consent` so Zoho returns a refresh token.
- Redirect URI: `https://<LIVE-URL>/api/zoho/callback`
- Known owner context: Zoho Projects portal "SAB Resources" CS-42, portal id `910285357`.

---

## 4. The API — 9 serverless functions

Consolidate aggressively; do not split these into more functions (12-function cap).

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/login` | GET / POST | session check / login / logout |
| `/api/data` | GET / POST | read whole app state; write one key |
| `/api/connections` | GET / DELETE | list connected accounts (no secrets); remove one |
| `/api/google/start` | GET | returns Google consent URL |
| `/api/google/callback` | GET | OAuth callback, stores encrypted refresh token |
| `/api/google/data` | POST | **multi-action** endpoint (see below) |
| `/api/zoho/start` | GET | returns Zoho consent URL |
| `/api/zoho/callback` | GET | OAuth callback, stores encrypted refresh token |
| `/api/zoho/data` | POST | Zoho tasks |

### [REV] `/api/data` write safety

`POST /api/data` receives `{ key, value }` and updates exactly that top-level key. Because every write is read-whole-doc → patch one key → write-whole-doc, two overlapping invocations can each read the old doc and the second write erases the first. Prevent this on both ends:

- **Server:** wrap the write in a **read-verify-retry** loop — re-read the doc immediately before writing, re-apply only the requested key, and write; if the underlying doc changed between read and write, retry (bounded, e.g. 3 attempts). Use Blob's overwrite semantics; never blind-write the whole client-held state.
- **Client:** keep a single in-flight write queue so `/api/data` is never called concurrently, and always send the **minimal** changed key (`blocks` for the current date, or `selectedCalendars`, etc.) — never the entire state blob.

`/api/google/data` takes `{ action, ...}` and supports:

- `"calendars"` → `{ accounts: [{ connId, email, calendars[] }] }`
- `"events"` `{ dateISO, cals: [{ connId, calendarIds[] }] }` → `{ events[] }`
  - **[REV]** Call the Calendar API with `singleEvents=true&orderBy=startTime` and `timeMin`/`timeMax` bounding `dateISO` **in the owner's timezone**, so recurring meetings return real instances, not recurrence masters.
  - Events returned with `start`/`end` as **minutes from midnight** via `toLocalMinutes` (see timezone section); all-day events are skipped.
- `"taskLists"` → `{ accounts: [{ connId, email, lists[] }] }`
- `"tasks"` `{ lists: [{ connId, listId }] }` → `{ tasks[] }` (default hides completed tasks — that is what we want)
- `"complete"` `{ connId, listId, taskId, completed }` → PATCHes Google Tasks.
  - **[REV]** When `completed` is true, PATCH `status:"completed"` **and** set `completed` to an RFC3339 timestamp. When `completed` is false, PATCH `status:"needsAction"` **and clear** the `completed` field — otherwise the task stays marked done.

`/api/zoho/data` takes `{ action: "tasks" }` → pulls open tasks from Zoho Projects (walk portals → projects → open tasks) and Zoho CRM (Tasks module, filter out completed).

Shared server helpers live in `api/_lib/` (underscore = not counted as functions):

- `store.js` — private-Blob read/write of the single doc (with the read-verify-retry write helper), passphrase check, session cookie make/verify (with expiry), `requireUser`, AES-GCM encrypt/decrypt of `refresh_token`, and connection CRUD (`listConnections`, `getConnection`, `saveConnection` (upsert on provider+email), `deleteConnection`)
- `state.js` — `signState` / `verifyState` (HMAC for the OAuth `state` param)
- `google.js` — token exchange/refresh + Calendar and Tasks REST calls via plain `fetch` (do NOT pull in the heavy `googleapis` package; keep cold starts fast)
- `zoho.js` — same shape for Zoho
- `time.js` — `toLocalMinutes(isoOrDate, tz)` and any other timezone helpers shared by server and referenced by the client's `lib.js`

---

## 5. The frontend

```
src/
  main.jsx              auth gate: loading → <Login> or <Planner>
  lib/
    api.js              fetch wrapper (credentials:"include" + Bearer fallback), login/logout/checkAuth
    lib.js              shared pure helpers + constants
  components/
    Login.jsx           passphrase form
    Planner.jsx         the whole planner (the big one)
    FocusCard.jsx       the floating focus card
```

### `lib/lib.js` — shared constants and pure functions

```js
PALETTE   = ["#D50000","#E67C00","#F09300","#33B679","#0B8043","#039BE5","#3F51B5","#7986CB","#8E24AA","#616161"]
DAY_START = 7 * 60      // grid starts 7:00am
DAY_END   = 22 * 60     // grid ends 10:00pm
SNAP_MIN  = 15          // everything snaps to 15-minute increments
BUFFER_MIN = 15         // auto prep-buffer before each meeting
```

Plus: `isoDate`, `addDays`, `startOfWeek`, `sameDay`, `label(min)` → "9:30 AM", `labelShort`, `snap`, `overlaps`, `hexA(hex, alpha)`, `nowMinutes(tz)` **[REV: timezone-aware]**, `buffersFrom(meetings)`, and `computeFocus({...})`.

**`computeFocus` is the brain of the focus card.** Given today's blocks, meetings, buffers, and the current minute (in the owner's timezone), it returns what to show, with this priority:

1. In a meeting right now → grey `#616161`, label = meeting title, sub = "In a meeting"
2. In a prep buffer → orange `#E67C00`, label = the meeting it's prepping for, sub = "Prep · 15 min"
3. In a task block → block color, label = block title (or the single task's title, or "N tasks"), sub = "3 of 5 left", and **`tasks[]` populated for the checklist**
4. In a project block → project color, label = project name, sub = "Focus now", note = project note
5. Nothing → grey `#5F6368`, "Open time" / "Nothing scheduled"

### `Planner.jsx` — what it must do

**Layout:** left sidebar (projects + tasks + connections), main area (day/week grid), floating focus card.

**Boot sequence:**

1. `GET /api/data` → hydrate projects, blocks, selected calendars/lists, timezone
2. `GET /api/connections` → list connected accounts
3. If any Google connection: `POST /api/google/data {action:"calendars"}` and `{action:"taskLists"}`
4. **First run only** (nothing selected yet): default-select ALL calendars and ALL task lists
5. Read `?connected=...&status=...` from the URL to show a "Google connected" banner, then clean the URL

**Persistence:** a debounced saver (400ms) that POSTs `{ key, value }` to `/api/data` **through the single in-flight write queue** (see §4 write safety). Every mutation to projects / blocks / selections calls it. Never save on every keystroke.

**Live clock:** `setInterval` every 30s updating `now` (minutes from midnight, computed in the owner's timezone). This drives the red now-line and the focus card.

**The day grid:**

- Hours 7am–10pm, hairline rows, `zoom` (px per minute, default 1.6)
- Red now-line with a dot, only on today
- Google meetings render as bordered white blocks (they are read-only, visually distinct from your own blocks)
- 15-min **prep buffers** auto-generated before every meeting, rendered as translucent orange
- Your blocks render as **solid color fills with white text**
- Blocks: drag body = move (change time). Drag bottom edge = resize (change duration). Everything snaps to 15 min.

**Drag-and-drop onto the grid — THREE modes (all required):**

1. **Single task** → drop one task → creates a task block with one task
2. **Batch tasks** → drag a whole task list header (or "all visible") → creates ONE task block containing all of them (this is the multi-task checklist)
3. **Project** → drag a project from the sidebar → creates a project block

Use a small drag threshold (~5px) so a click still registers as a click.

**Tasks sidebar:**

- Grouped by source: each Google account's task lists, then Zoho
- Filter toggle: **All** / **Today** (Today = tasks whose due date is the currently-viewed date)
- Collapsible groups
- Checking a task off here calls `applyTaskCompletion`

**`applyTaskCompletion(connId, listId, taskId, completed)`** — must do all three:

1. Optimistically update the task's status inside any block that contains it
2. Optimistically update the sidebar task list
3. `POST /api/google/data {action:"complete", ...}` to write it back to Google (the endpoint handles the set/clear of the `completed` field per §4)

**`advanceToNext()`** — the Next button. Finds the block after the current one and shifts focus to it. **It must NOT modify the current block's tasks.** (This was an explicit owner decision.)

**Reminders:** browser `Notification` API. Ask permission via a button (never on load). Schedule a notification for each block's start time. Note honestly in the UI that browser notifications only fire while a tab is open — this is a real browser limitation.

### `FocusCard.jsx`

An in-page, `position: fixed`, high-z-index card. Draggable and resizable by the user; position/size persisted to `localStorage`. One solid color fill (`focus.color`), white text. Shows: sub-label (uppercase, small), main label (big), the task checklist with round check circles (click to toggle), the current time, and a "Next ›" button plus a hide "×".

**Honest limitation to state in the UI:** a browser tab cannot float above your *other applications*. Within the planner page it behaves exactly like the desktop card. True always-on-top requires the desktop companion (§8).

---

## 6. Environment variables

Set in Vercel → Project Settings → Environment Variables. **There are no `VITE_` public vars** — the browser only ever talks to our own `/api`, so nothing secret ships to the client.

| Var | Purpose |
|---|---|
| `APP_PASSPHRASE` | what the owner types on the login screen |
| `SESSION_SECRET` | long random string; signs the session cookie AND the OAuth state param, and derives the AES key for encrypting refresh tokens at rest |
| `BLOB_READ_WRITE_TOKEN` | **auto-set by Vercel** when a Blob store is connected. Do not set by hand. |
| `GOOGLE_CLIENT_ID` | from the Google "Web application" OAuth client |
| `GOOGLE_CLIENT_SECRET` | same |
| `ZOHO_CLIENT_ID` | from the Zoho **Server-based Application** client |
| `ZOHO_CLIENT_SECRET` | same |
| `ZOHO_ACCOUNTS_DOMAIN` | `https://accounts.zoho.com` (US default) |

---

## 7. Build order — do it in this sequence

**Phase 1 — Repo and pipeline first. This is the whole point. Do not build features before this works.**

1. `git init` the project locally, scaffold Vite + React.
2. Create a GitHub repo and push.
3. Import the repo into Vercel. Confirm auto-deploy on push works. **Get a live URL.**
4. In Vercel: Storage → Create → Blob, as a **private** store. This auto-injects `BLOB_READ_WRITE_TOKEN`.
5. Set `APP_PASSPHRASE` and `SESSION_SECRET`.
6. **Verify the loop:** make a trivial change (e.g. the page title), commit, push, and confirm it appears live within ~60s. Nothing else proceeds until this is proven.

**Phase 2 — Skeleton + auth (bake in secret-at-rest now — it is painful to retrofit)**

7. `api/_lib/store.js` (private-Blob read/write with read-verify-retry, session with expiry, AES-GCM encrypt/decrypt), `api/login.js`, `api/data.js`, `api/connections.js`
8. `Login.jsx`, `main.jsx` auth gate
9. Deploy. Confirm you can log in with the passphrase and that state round-trips through Blob.

**Phase 3 — The planner UI (nail timezone before real calendar data arrives)**

10. `api/_lib/time.js` (`toLocalMinutes`), `lib/lib.js`, `Planner.jsx`, `FocusCard.jsx`
11. Projects CRUD, the day grid, drag/resize, the focus card — driven by mock data first
12. Deploy, confirm the look matches the Google-Calendar spec.

**Phase 4 — Google (this is the point of the app)**

13. Owner creates a Google Cloud project → enable Calendar API + Tasks API → create a **"Web application"** OAuth client → add redirect `https://<LIVE-URL>/api/google/callback` → set `GOOGLE_CLIENT_ID`/`SECRET` in Vercel.
14. Build `api/_lib/google.js`, `api/google/{start,callback,data}.js` (events use `singleEvents=true` + `toLocalMinutes`)
15. Wire the sidebar: connect button, calendar picker, task lists, drag-to-grid, check-off write-back.
16. Deploy and verify against the owner's real calendar and tasks.

**Phase 5 — Zoho**

17. Owner creates a Zoho **Server-based Application** client → redirect `https://<LIVE-URL>/api/zoho/callback` → set `ZOHO_CLIENT_ID`/`SECRET`.
18. Build `api/_lib/zoho.js`, `api/zoho/{start,callback,data}.js`, add Zoho tasks to the sidebar.
19. Deploy and verify.

**Phase 6 — Polish**

20. Week view, reminders, keyboard niceties.

---

## 8. Later (not now): the desktop companion

A browser cannot do two things: float a window above *other apps*, and fire reminders when the app is closed. Once the web app is solid, a thin Electron companion can be added that does ONLY those two things — an always-on-top floating card and always-on reminders — pointing at the same web API. All logic and sync stay in the web app. Build once, use everywhere.

A complete Electron version of this planner already exists and works (frameless transparent always-on-top card, native notifications, Google integration). It can be cannibalized for the companion when the time comes.

---

## 9. Working agreement with the owner

- **Never guess how a platform, API, or library works. Look up the official docs and follow them exactly.** This applies to Google, Zoho, Vercel, and every npm package. Verify package versions with `npm view <pkg> version` rather than assuming.
- The owner is not a developer and should never have to move files by hand. Claude Code edits, commits, pushes.
- Ask before making decisions that touch the owner's other systems. Never modify their Supabase projects.
- Be honest about limitations rather than papering over them.
