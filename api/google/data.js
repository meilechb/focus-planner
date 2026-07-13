// Multi-action Google endpoint. POST { action, ... }.
//   "calendars" -> { accounts: [{ connId, email, calendars[] }] }
//   "events"    { dateISO, cals:[{connId, calendarIds[]}] } -> { events[] }  (minutes from midnight)
//   "taskLists" -> { accounts: [{ connId, email, lists[] }] }
//   "tasks"     { lists:[{connId, listId}] } -> { tasks[] }
//   "complete"  { connId, listId, taskId, completed } -> { ok }
import { requireUser, listConnections, getConnection, getPublicState } from '../_lib/store.js'
import {
  refreshAccessToken, listCalendars, listEvents, listEventsRange, listTaskLists, listTasks, setTaskCompleted,
} from '../_lib/google.js'

const clientId = () => process.env.GOOGLE_CLIENT_ID
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET

async function tokenFor(connId) {
  const conn = await getConnection(connId)
  if (!conn || conn.provider !== 'google') throw new Error('unknown google connection')
  const accessToken = await refreshAccessToken({
    refreshToken: conn.refresh_token,
    clientId: clientId(),
    clientSecret: clientSecret(),
  })
  return { conn, accessToken }
}

export default async function handler(req, res) {
  try {
    if (!requireUser(req)) return res.status(401).json({ error: 'unauthorized' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'method not allowed' })
    }
    let body
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} }
    catch { return res.status(400).json({ error: 'invalid JSON body' }) }
    const { action } = body

    const googleConns = (await listConnections()).filter((c) => c.provider === 'google')
    // Legacy connections (no features field) had both.
    const hasFeature = (c, f) => !c.extra?.features || c.extra.features.includes(f)

    if (action === 'calendars') {
      const accounts = []
      for (const c of googleConns) {
        if (!hasFeature(c, 'calendar')) continue
        try {
          const { accessToken } = await tokenFor(c.id)
          accounts.push({ connId: c.id, email: c.account_email, calendars: await listCalendars(accessToken) })
        } catch (e) {
          accounts.push({ connId: c.id, email: c.account_email, calendars: [], error: String(e.message || e) })
        }
      }
      return res.status(200).json({ accounts })
    }

    if (action === 'taskLists') {
      const accounts = []
      for (const c of googleConns) {
        if (!hasFeature(c, 'tasks')) continue
        try {
          const { accessToken } = await tokenFor(c.id)
          accounts.push({ connId: c.id, email: c.account_email, lists: await listTaskLists(accessToken) })
        } catch (e) {
          accounts.push({ connId: c.id, email: c.account_email, lists: [], error: String(e.message || e) })
        }
      }
      return res.status(200).json({ accounts })
    }

    if (action === 'events') {
      const { dateISO, cals = [] } = body
      const tz = (await getPublicState()).timezone || 'America/New_York'
      const events = []
      for (const entry of cals) {
        let accessToken
        try { ;({ accessToken } = await tokenFor(entry.connId)) } catch { continue }
        for (const calendarId of entry.calendarIds || []) {
          try {
            const evs = await listEvents({ accessToken, calendarId, dateISO, tz })
            for (const e of evs) events.push({ ...e, connId: entry.connId, calendarId })
          } catch { /* skip a calendar that errors */ }
        }
      }
      return res.status(200).json({ events })
    }

    if (action === 'eventsRange') {
      const { startISO, endISO, cals = [] } = body
      const tz = (await getPublicState()).timezone || 'America/New_York'
      const events = []
      for (const entry of cals) {
        let accessToken
        try {
          ;({ accessToken } = await tokenFor(entry.connId))
        } catch {
          continue
        }
        for (const calendarId of entry.calendarIds || []) {
          try {
            const evs = await listEventsRange({ accessToken, calendarId, startISO, endISO, tz })
            for (const e of evs) events.push({ ...e, connId: entry.connId, calendarId })
          } catch {
            /* skip a calendar that errors */
          }
        }
      }
      return res.status(200).json({ events })
    }

    if (action === 'tasks') {
      const { lists = [] } = body
      const tasks = []
      // Cache access tokens per connection so we don't refresh once per list.
      const tokenCache = {}
      for (const entry of lists) {
        try {
          if (!tokenCache[entry.connId]) tokenCache[entry.connId] = (await tokenFor(entry.connId)).accessToken
          const ts = await listTasks({ accessToken: tokenCache[entry.connId], listId: entry.listId })
          for (const t of ts) tasks.push({ ...t, connId: entry.connId, listId: entry.listId })
        } catch { /* skip a failing list rather than zeroing everything */ }
      }
      return res.status(200).json({ tasks })
    }

    if (action === 'complete') {
      const { connId, listId, taskId, completed } = body
      const { accessToken } = await tokenFor(connId)
      await setTaskCompleted({ accessToken, listId, taskId, completed })
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
