// Google OAuth + Calendar + Tasks via plain fetch (no googleapis package, to
// keep serverless cold starts fast). Access tokens are minted on demand from
// the stored refresh token; only refresh tokens are persisted (encrypted).
import { toLocalMinutes, localDateISO, zonedDayRange } from './time.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

const BASE_SCOPES = ['openid', 'email', 'profile']
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

// mode: 'all' = calendar + tasks, 'tasks' = tasks only (e.g. a personal account).
export function scopesFor(mode) {
  const s = [...BASE_SCOPES, TASKS_SCOPE]
  if (mode !== 'tasks') s.unshift(CAL_SCOPE)
  return s
}

export function featuresFor(mode) {
  return mode === 'tasks' ? ['tasks'] : ['calendar', 'tasks']
}

export function buildAuthUrl({ clientId, redirectUri, state, mode = 'all' }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopesFor(mode).join(' '),
    access_type: 'offline',
    // select_account lets you pick/add a different account each time (multi-account);
    // consent guarantees a refresh token.
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${p.toString()}`
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`google token exchange: ${data.error_description || data.error || res.status}`)
  return data // { access_token, refresh_token, expires_in, id_token, ... }
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`google token refresh: ${data.error_description || data.error || res.status}`)
  return data.access_token
}

async function gfetch(url, accessToken, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) },
  })
  if (res.status === 204) return {}
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`google api ${res.status}: ${data.error?.message || JSON.stringify(data)}`)
  return data
}

export async function getUserEmail(accessToken) {
  const info = await gfetch(USERINFO_URL, accessToken)
  return info.email || null
}

export async function listCalendars(accessToken) {
  const data = await gfetch(`${CAL_BASE}/users/me/calendarList?minAccessRole=reader`, accessToken)
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    primary: !!c.primary,
    color: c.backgroundColor,
  }))
}

// Events on `dateISO` (owner tz), timed events only, as minutes-from-midnight.
export async function listEvents({ accessToken, calendarId, dateISO, tz }) {
  const { timeMin, timeMax } = zonedDayRange(dateISO, tz)
  const p = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin,
    timeMax,
    maxResults: '250',
  })
  const data = await gfetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${p.toString()}`,
    accessToken,
  )
  const out = []
  for (const ev of data.items || []) {
    if (ev.status === 'cancelled') continue
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue // skip all-day
    out.push({
      id: ev.id,
      title: ev.summary || '(no title)',
      start: toLocalMinutes(ev.start.dateTime, tz),
      end: toLocalMinutes(ev.end.dateTime, tz),
    })
  }
  return out
}

// Timed events across [startISO, endISO] (inclusive, owner tz), each tagged
// with its local date + minutes. Used by Week/Month views.
export async function listEventsRange({ accessToken, calendarId, startISO, endISO, tz }) {
  const timeMin = zonedDayRange(startISO, tz).timeMin
  const timeMax = zonedDayRange(endISO, tz).timeMax
  const p = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin,
    timeMax,
    maxResults: '2500',
  })
  const data = await gfetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${p.toString()}`,
    accessToken,
  )
  const out = []
  for (const ev of data.items || []) {
    if (ev.status === 'cancelled') continue
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue // skip all-day
    out.push({
      id: ev.id,
      title: ev.summary || '(no title)',
      date: localDateISO(ev.start.dateTime, tz),
      start: toLocalMinutes(ev.start.dateTime, tz),
      end: toLocalMinutes(ev.end.dateTime, tz),
    })
  }
  return out
}

export async function listTaskLists(accessToken) {
  const data = await gfetch(`${TASKS_BASE}/users/@me/lists?maxResults=100`, accessToken)
  return (data.items || []).map((l) => ({ id: l.id, title: l.title }))
}

// Open tasks in a list (completed hidden by default).
export async function listTasks({ accessToken, listId }) {
  const p = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100' })
  const data = await gfetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks?${p.toString()}`,
    accessToken,
  )
  return (data.items || []).map((t) => ({
    id: t.id,
    title: t.title || '(untitled)',
    status: t.status,
    due: t.due || null,
  }))
}

export async function setTaskCompleted({ accessToken, listId, taskId, completed }) {
  const body = completed
    ? { status: 'completed', completed: new Date().toISOString() }
    : { status: 'needsAction', completed: null }
  return gfetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    accessToken,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
}
