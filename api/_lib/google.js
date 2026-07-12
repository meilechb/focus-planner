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

// feats: array of 'calendar' and/or 'tasks'. One connector, you pick what it syncs.
export function parseFeats(str) {
  const f = (str || 'calendar,tasks').split(',').map((s) => s.trim()).filter((x) => x === 'calendar' || x === 'tasks')
  return f.length ? f : ['calendar', 'tasks']
}

export function scopesFor(feats) {
  const s = [...BASE_SCOPES]
  if (feats.includes('calendar')) s.push(CAL_SCOPE)
  if (feats.includes('tasks')) s.push(TASKS_SCOPE)
  return s
}

export function buildAuthUrl({ clientId, redirectUri, state, feats = ['calendar', 'tasks'] }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopesFor(feats).join(' '),
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

// Pull a usable meeting link out of an event (Meet, Zoom, etc.).
function meetingLink(ev) {
  if (ev.hangoutLink) return ev.hangoutLink
  const eps = ev.conferenceData?.entryPoints || []
  const video = eps.find((e) => e.entryPointType === 'video')
  if (video?.uri) return video.uri
  const more = eps.find((e) => e.entryPointType === 'more')
  return more?.uri || null
}

// Google descriptions can hold light HTML; flatten to readable plain text.
function cleanDesc(d) {
  if (!d) return null
  let s = String(d)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s ? s.slice(0, 4000) : null
}

function mapEvent(ev, tz, withDate) {
  const start = toLocalMinutes(ev.start.dateTime, tz)
  let end = toLocalMinutes(ev.end.dateTime, tz)
  // An event ending at (or past) local midnight maps end to 0/next-day, which
  // would produce a zero/negative-duration block. Clamp it to end-of-day.
  if (end <= start || localDateISO(ev.end.dateTime, tz) > localDateISO(ev.start.dateTime, tz)) end = 1440
  const out = {
    id: ev.id,
    title: ev.summary || '(no title)',
    start,
    end,
    location: ev.location || null,
    description: cleanDesc(ev.description),
    link: meetingLink(ev),
    htmlLink: ev.htmlLink || null,
    organizer: ev.organizer?.displayName || ev.organizer?.email || null,
    attendees: Array.isArray(ev.attendees)
      ? ev.attendees.filter((a) => !a.resource).slice(0, 30)
          .map((a) => ({ email: a.email || null, name: a.displayName || null, self: !!a.self, status: a.responseStatus || null }))
      : [],
  }
  if (withDate) out.date = localDateISO(ev.start.dateTime, tz)
  return out
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
    out.push(mapEvent(ev, tz, false))
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
    out.push(mapEvent(ev, tz, true))
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
