import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  PALETTE, DAY_START, DAY_END, SNAP_MIN, ACCENT,
  isoDate, addDays, addMonths, weekDays, monthGridDays, monthOf, dayNum,
  label, labelShort, hourLabel, snap, clamp, uuid, buffersFrom, computeFocus, nowMinutes, localDateISO,
  fitDrop, clampMove, clampResizeBottom, clampResizeTop,
} from '../lib/lib.js'
import FocusCard from './FocusCard.jsx'
import { Icon } from './Icon.jsx'

const DEFAULT_TZ = 'America/New_York'
const ZOOM_KEY = 'focus_zoom'
const VIEW_START = 8 * 60 // default: scroll so the day starts at 8 AM
const VIEW_HOURS = 10 // default density: fit ~8 AM–6 PM in view
// Default density: pick px-per-minute so ~10 hours fill the visible calendar.
function defaultZoom() {
  const h = (typeof window !== 'undefined' ? window.innerHeight : 900) - 150
  return Math.min(3, Math.max(1, h / (VIEW_HOURS * 60)))
}
const CACHE_KEY = 'focus_cache'
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} } }
const SEEN_KEY = 'focus_seen_accounts'
function readSeen() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() } }
function writeSeen(set) { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set])) } catch {} }
const NAVCFG_KEY = 'focus_navcfg'
const DEFAULT_NAVCFG = { modules: { google: true, deals: true, leads: true, projects: true }, zohoAssignee: 'mine', filters: { deals: [], leads: [], projects: [] }, colors: {} }
// One source of truth for connector colors. A block dropped from a source, the
// sidebar section, and the focus card ALL use this — so a Google task is the
// same color everywhere. Users can override per source in Settings.
const DEFAULT_COLORS = { google: '#2563eb', 'zoho-crm': '#e42527', 'zoho-projects': '#e8590c' }
const COLOR_CHOICES = ['#2563eb', '#0f9d58', '#e8590c', '#e42527', '#8e24aa', '#0891b2', '#d97706', '#616161']
function srcKey(gid) { return gid === 'zoho-crm' ? 'zoho-crm' : gid === 'zoho-projects' ? 'zoho-projects' : 'google' }
function srcColor(navCfg, gid) { const k = srcKey(gid); return (navCfg?.colors && navCfg.colors[k]) || DEFAULT_COLORS[k] }
function readNavCfg() { try { return { ...DEFAULT_NAVCFG, ...JSON.parse(localStorage.getItem(NAVCFG_KEY) || '{}') } } catch { return { ...DEFAULT_NAVCFG } } }
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const timeToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

export default function Planner() {
  const [tz, setTz] = useState(() => readCache().tz || DEFAULT_TZ)
  const [projects, setProjects] = useState(() => readCache().projects || [])
  const [blocks, setBlocks] = useState(() => readCache().blocks || {})
  const [favorites, setFavorites] = useState(() => readCache().favorites || [])
  const [connections, setConnections] = useState(() => readCache().connections || [])
  const [storageOk, setStorageOk] = useState(true)
  const [toasts, setToasts] = useState([])
  const toastTimers = useRef({})
  function pushToast(msg, kind = 'info') {
    const id = uuid()
    setToasts((t) => [...t.slice(-3), { id, msg, kind }])
    toastTimers.current[id] = setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }
  function dismissToast(id) { clearTimeout(toastTimers.current[id]); setToasts((t) => t.filter((x) => x.id !== id)) }

  const [calAccounts, setCalAccounts] = useState(() => readCache().calAccounts || [])
  const [taskAccounts, setTaskAccounts] = useState(() => readCache().taskAccounts || [])
  const [selectedCalendars, setSelectedCalendars] = useState(() => readCache().selectedCalendars || [])
  const [selectedTaskLists, setSelectedTaskLists] = useState(() => readCache().selectedTaskLists || [])
  const [eventsByDate, setEventsByDate] = useState(() => readCache().eventsByDate || {}) // { 'YYYY-MM-DD': [events] } — cached per day for instant paint
  const [gtasks, setGtasks] = useState(() => readCache().gtasks || [])
  const [zoho, setZoho] = useState(() => readCache().zoho || { crm: { deals: [], leads: [] }, projects: [], errors: [] })

  const [viewDate, setViewDate] = useState(() => isoDate(new Date(), readCache().tz || DEFAULT_TZ))
  const [view, setView] = useState(() => readCache().view || 'day') // day | week | month
  const [zoom, setZoom] = useState(() => { const s = Number(localStorage.getItem(ZOOM_KEY)); return s ? Math.min(3, Math.max(1, s)) : defaultZoom() })
  const [now, setNow] = useState(() => nowMinutes(readCache().tz || DEFAULT_TZ))
  const [theme, setTheme] = useState(() => localStorage.getItem('focus_theme') || 'system')
  useEffect(() => {
    const r = document.documentElement
    if (theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', theme)
    try { localStorage.setItem('focus_theme', theme) } catch {}
  }, [theme])

  const [taskFilter, setTaskFilter] = useState('all')
  const [taskSearch, setTaskSearch] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [sections, setSections] = useState(() => readCache().sections || { projects: false, tasks: false })
  const [sidebarOpen, setSidebarOpen] = useState(() => readCache().sidebarOpen !== false)
  const [focusHidden, setFocusHidden] = useState(() => { const c = readCache(); return c.focusHidden === undefined ? true : !!c.focusHidden })
  const [overrideBlockId, setOverrideBlockId] = useState(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [editProject, setEditProject] = useState(null)
  const [editBlock, setEditBlock] = useState(null) // { block, day }
  const [showConn, setShowConn] = useState(false)
  const [settingsTab, setSettingsTab] = useState('connections')
  const openSettings = (tab) => { setSettingsTab(typeof tab === 'string' ? tab : 'connections'); setShowConn(true) }
  const [showHelp, setShowHelp] = useState(false)
  const [showCmd, setShowCmd] = useState(false)
  const [navCfg, setNavCfg] = useState(readNavCfg)
  const [viewEvent, setViewEvent] = useState(null) // a Google Calendar event to inspect
  function updateNavCfg(n) { setNavCfg(n); try { localStorage.setItem(NAVCFG_KEY, JSON.stringify(n)) } catch {} }

  const today = isoDate(new Date(), tz)
  const connected = connections.some((c) => c.provider === 'google')
  const hasZoho = connections.some((c) => c.provider === 'zoho')

  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)) }, [zoom])
  // instant paint on next load — cache everything the UI renders from
  useEffect(() => {
    try {
      // prune cached events to a rolling window so localStorage stays small
      const lo = addDays(today, -31), hi = addDays(today, 92)
      const ebd = {}
      for (const k in eventsByDate) if (k >= lo && k <= hi) ebd[k] = eventsByDate[k]
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        tz, projects, blocks, favorites, selectedCalendars, selectedTaskLists,
        connections, calAccounts, taskAccounts, eventsByDate: ebd, gtasks, zoho, focusHidden,
        view, sidebarOpen, sections,
      }))
    } catch {}
  }, [tz, projects, blocks, favorites, selectedCalendars, selectedTaskLists, connections, calAccounts, taskAccounts, eventsByDate, gtasks, zoho, focusHidden, today, view, sidebarOpen, sections])

  // --- boot -----------------------------------------------------------------
  useEffect(() => {
    ;(async () => {
      let state = null
      // fire both requests in parallel
      const dataP = api.get('/api/data')
      const connP = api.get('/api/connections').catch(() => null) // null = fetch failed (keep cache)
      try {
        const r = await dataP
        state = r.state
        if (state.timezone) setTz(state.timezone)
        setProjects(state.projects || [])
        setBlocks(state.blocks || {})
        setFavorites(state.favorites || [])
        setSelectedCalendars(state.selectedCalendars || [])
        setSelectedTaskLists(state.selectedTaskLists || [])
        setStorageOk(true)
        // Heal: if the server doc is empty but we have cached local data (e.g. a
        // prior save failed), restore it and push it back up.
        const cache = readCache()
        const serverEmpty = !(state.projects || []).length && !Object.keys(state.blocks || {}).length
        if (serverEmpty && ((cache.projects || []).length || Object.keys(cache.blocks || {}).length)) {
          if ((cache.projects || []).length) { setProjects(cache.projects); saveKey('projects', cache.projects) }
          if (Object.keys(cache.blocks || {}).length) { setBlocks(cache.blocks); saveKey('blocks', cache.blocks) }
        }
      } catch { setStorageOk(false) }
      // On a failed connections fetch, keep whatever we cached instead of wiping
      // the user's connected accounts to zero.
      const cr = await connP
      let conns = readCache().connections || []
      if (cr) { conns = cr.connections || []; setConnections(conns) }
      if (conns.some((c) => c.provider === 'google')) await loadGoogleMeta(state)
      if (conns.some((c) => c.provider === 'zoho')) loadZoho()
      const p = new URLSearchParams(location.search)
      if (p.get('connected')) {
        const st = p.get('status')
        const prov = p.get('connected'); const name = prov ? prov[0].toUpperCase() + prov.slice(1) : 'Account'
        pushToast(st === 'ok' ? `${name} connected` : `Couldn't connect ${name} (${st})`, st === 'ok' ? 'success' : 'error')
        history.replaceState({}, '', location.pathname)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadGoogleMeta(state) {
    try {
      const [cal, tl] = await Promise.all([
        api.post('/api/google/data', { action: 'calendars' }),
        api.post('/api/google/data', { action: 'taskLists' }),
      ])
      setCalAccounts(cal.accounts || [])
      setTaskAccounts(tl.accounts || [])
      // Auto-select an account's calendars/lists ONCE, the first time we ever
      // see it. After that we remember it (seen set) and never re-add, so if the
      // user deliberately unchecks all of an account's calendars it stays that way.
      const seen = readSeen()
      const baseCals = state?.selectedCalendars || readCache().selectedCalendars || []
      const nextCals = [...baseCals]
      for (const a of cal.accounts || []) {
        if (seen.has('cal:' + a.connId)) continue
        seen.add('cal:' + a.connId)
        for (const c of a.calendars) { const k = `${a.connId}::${c.id}`; if (!nextCals.includes(k)) nextCals.push(k) }
      }
      if (nextCals.length !== baseCals.length) { setSelectedCalendars(nextCals); saveKey('selectedCalendars', nextCals) }

      const baseLists = state?.selectedTaskLists || readCache().selectedTaskLists || []
      const nextLists = [...baseLists]
      for (const a of tl.accounts || []) {
        if (seen.has('list:' + a.connId)) continue
        seen.add('list:' + a.connId)
        for (const l of a.lists) { const k = `${a.connId}::${l.id}`; if (!nextLists.includes(k)) nextLists.push(k) }
      }
      if (nextLists.length !== baseLists.length) { setSelectedTaskLists(nextLists); saveKey('selectedTaskLists', nextLists) }
      writeSeen(seen)
    } catch (e) { console.error('google meta', e) }
  }
  async function loadZoho() {
    try {
      const r = await api.post('/api/zoho/data', { action: 'fetch' })
      // Normalize into the exact shape the UI expects, so a partial/error
      // response can never crash the planner on the next render.
      setZoho({
        crm: {
          deals: r?.crm?.deals || [], leads: r?.crm?.leads || [],
          dealFields: r?.crm?.dealFields || [], leadFields: r?.crm?.leadFields || [],
        },
        projects: Array.isArray(r?.projects) ? r.projects : [],
        errors: r?.errors || [],
      })
    } catch (e) { console.error('zoho', e) }
  }
  async function disconnect(id) {
    const gone = connections.find((c) => c.id === id)
    await api.del('/api/connections?id=' + id).catch(() => {})
    setConnections((await api.get('/api/connections').catch(() => ({ connections: [] }))).connections || [])
    pushToast(`${gone?.provider === 'zoho' ? 'Zoho' : 'Google'} account disconnected`, 'info')
  }

  // --- visible range for the grid ------------------------------------------
  const range = useMemo(() => {
    if (view === 'day') return { start: viewDate, end: viewDate }
    if (view === 'week') { const d = weekDays(viewDate); return { start: d[0], end: d[6] } }
    const g = monthGridDays(viewDate); return { start: g[0], end: g[41] }
  }, [view, viewDate])

  function calsPayload() {
    const byConn = {}
    for (const key of selectedCalendars) { const [c, id] = key.split('::'); (byConn[c] ||= []).push(id) }
    return Object.entries(byConn).map(([connId, calendarIds]) => ({ connId, calendarIds }))
  }

  // Merge a fetched events[] into the by-date cache, marking every date in the
  // range as loaded (empty array) so we don't refetch known-empty days.
  function mergeEvents(startISO, endISO, events) {
    setEventsByDate((prev) => {
      const next = { ...prev }
      let d = startISO
      while (d <= endISO) { next[d] = []; d = addDays(d, 1) }
      for (const e of events) (next[e.date] ||= []).push(e)
      return next
    })
  }

  useEffect(() => {
    if (!connected || !selectedCalendars.length) return
    let alive = true
    api.post('/api/google/data', { action: 'eventsRange', startISO: range.start, endISO: range.end, cals: calsPayload() })
      .then((r) => { if (alive) mergeEvents(range.start, range.end, r.events || []) })
      .catch(() => {}) // keep cached events on transient error
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedCalendars, range.start, range.end, refreshNonce])

  useEffect(() => {
    if (!connected || !selectedCalendars.length) return
    if (today >= range.start && today <= range.end) return // already covered by the range fetch
    let alive = true
    api.post('/api/google/data', { action: 'eventsRange', startISO: today, endISO: today, cals: calsPayload() })
      .then((r) => { if (alive) mergeEvents(today, today, r.events || []) })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedCalendars, today, range.start, range.end, refreshNonce])

  useEffect(() => {
    if (!connected || !selectedTaskLists.length) { setGtasks([]); return }
    const lists = selectedTaskLists.map((k) => { const [connId, listId] = k.split('::'); return { connId, listId } })
    let alive = true
    api.post('/api/google/data', { action: 'tasks', lists })
      .then((r) => { if (alive) setGtasks(r.tasks || []) })
      .catch(() => {}) // keep cached tasks on transient error (don't zero the sidebar)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedTaskLists, refreshNonce])

  useEffect(() => { const id = setInterval(() => setNow(nowMinutes(tz)), 30000); setNow(nowMinutes(tz)); return () => clearInterval(id) }, [tz])

  // Refresh calendar + tasks when the tab regains focus (throttled to 45s) and
  // every 5 minutes while open, so data never goes stale behind the user.
  useEffect(() => {
    let last = 0
    const bump = () => { const t = Date.now(); if (t - last < 45000) return; last = t; setRefreshNonce((n) => n + 1) }
    const onVis = () => { if (document.visibilityState === 'visible') bump() }
    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(bump, 300000)
    return () => { window.removeEventListener('focus', bump); document.removeEventListener('visibilitychange', onVis); clearInterval(id) }
  }, [])

  // keyboard shortcuts: T=today, D/W/M=views, ←/→=navigate
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setShowCmd((v) => !v); return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (e.target.closest && e.target.closest('input, textarea')) return
        e.preventDefault(); undoBlocks(); return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target.closest && e.target.closest('input, textarea, .modal')) return
      const k = e.key.toLowerCase()
      const nav = (dir) => setViewDate((v) => (view === 'month' ? addMonths(v, dir) : addDays(v, dir * (view === 'week' ? 7 : 1))))
      if (k === 't') setViewDate(today)
      else if (k === 'd') setView('day')
      else if (k === 'w') setView('week')
      else if (k === 'm') setView('month')
      else if (k === '?' || (e.key === '/' && e.shiftKey)) setShowHelp((v) => !v)
      else if (e.key === 'Escape') setShowHelp(false)
      else if (e.key === 'ArrowLeft') nav(-1)
      else if (e.key === 'ArrowRight') nav(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [today, view])

  // Escape closes whatever modal/popover is open.
  useEffect(() => {
    function onEsc(e) {
      if (e.key !== 'Escape') return
      setEditBlock(null); setEditProject(null); setShowConn(false); setShowHelp(false); setViewEvent(null); setShowCmd(false)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])

  // Never lose an edit: flush any pending saves synchronously when the tab is
  // hidden or closed (debounced writes may not have fired yet).
  useEffect(() => {
    const flushBeacon = () => {
      if (!pending.current.size) return
      for (const [key, value] of pending.current.entries()) {
        try { navigator.sendBeacon('/api/data', new Blob([JSON.stringify({ key, value })], { type: 'application/json' })) } catch {}
      }
      pending.current.clear()
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flushBeacon() }
    window.addEventListener('pagehide', flushBeacon)
    window.addEventListener('beforeunload', flushBeacon)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('pagehide', flushBeacon); window.removeEventListener('beforeunload', flushBeacon); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  // --- persistence ----------------------------------------------------------
  const pending = useRef(new Map()); const timer = useRef(null); const flushing = useRef(false)
  function saveKey(key, value) { pending.current.set(key, value); clearTimeout(timer.current); timer.current = setTimeout(flush, 350) }
  async function flush() {
    if (flushing.current) return; flushing.current = true
    try {
      while (pending.current.size) {
        const [key, value] = pending.current.entries().next().value
        try {
          await api.post('/api/data', { key, value })
          pending.current.delete(key) // only drop once persisted
          setStorageOk(true)
        } catch {
          setStorageOk(false) // keep it queued and retry shortly
          clearTimeout(timer.current); timer.current = setTimeout(flush, 3000)
          break
        }
      }
    } finally { flushing.current = false }
  }

  function updateProjects(n) { setProjects(n); saveKey('projects', n) }
  const undoStack = useRef([])
  function updateBlocks(n) { undoStack.current.push(blocks); if (undoStack.current.length > 60) undoStack.current.shift(); setBlocks(n); saveKey('blocks', n) }
  function undoBlocks() { const prev = undoStack.current.pop(); if (prev) { setBlocks(prev); saveKey('blocks', prev); pushToast('Change reverted', 'info') } else { pushToast('Nothing to undo', 'info') } }
  const dayBlocks = (d) => blocks[d] || []
  function duplicateBlock(day, block) {
    const occ = [...meetingsFor(day), ...buffersFrom(meetingsFor(day)), ...(blocks[day] || [])]
    const dur = block.end - block.start
    const slot = fitDrop(occ, block.end, dur) || fitDrop(occ, DAY_START, dur)
    if (slot) addBlockTo(day, { ...block, id: uuid(), start: slot.start, end: slot.end })
  }
  function setDayBlocks(d, list) { updateBlocks({ ...blocks, [d]: list }) }
  function addBlockTo(d, b) { updateBlocks({ ...blocks, [d]: [...(blocks[d] || []), b] }) }
  function updateBlock(d, b) { updateBlocks({ ...blocks, [d]: (blocks[d] || []).map((x) => (x.id === b.id ? b : x)) }) }
  function deleteBlock(d, id) { updateBlocks({ ...blocks, [d]: (blocks[d] || []).filter((x) => x.id !== id) }) }

  function newProject() { setEditProject({ id: uuid(), name: '', color: PALETTE[projects.length % PALETTE.length], note: '', isNew: true }) }
  function saveProject(p) {
    const clean = { ...p }; delete clean.isNew
    updateProjects(projects.some((x) => x.id === p.id) ? projects.map((x) => (x.id === p.id ? clean : x)) : [...projects, clean])
    setEditProject(null)
  }
  function deleteProject(id) { updateProjects(projects.filter((x) => x.id !== id)); unfav('p:' + id) }
  const isFav = (id) => favorites.some((f) => f.id === id)
  function toggleFav(entry) { const next = isFav(entry.id) ? favorites.filter((f) => f.id !== entry.id) : [...favorites, entry]; setFavorites(next); saveKey('favorites', next) }
  function unfav(id) { if (isFav(id)) { const next = favorites.filter((f) => f.id !== id); setFavorites(next); saveKey('favorites', next) } }

  function toggleCalendar(k) { const n = selectedCalendars.includes(k) ? selectedCalendars.filter((x) => x !== k) : [...selectedCalendars, k]; setSelectedCalendars(n); saveKey('selectedCalendars', n) }
  function toggleTaskList(k) { const n = selectedTaskLists.includes(k) ? selectedTaskLists.filter((x) => x !== k) : [...selectedTaskLists, k]; setSelectedTaskLists(n); saveKey('selectedTaskLists', n) }

  const meetingsFor = (d) => (connected ? (eventsByDate[d] || []) : [])

  // --- task groups ----------------------------------------------------------
  const displayGroups = useMemo(() => {
    const q = taskSearch.trim().toLowerCase()
    const dueOk = (t) => taskFilter === 'all' || (t.due && localDateISO(t.due, tz) <= today)
    const searchOk = (t) => !q || (t.title || '').toLowerCase().includes(q) || (t.sub || '').toLowerCase().includes(q)
    // Overdue/soonest first, then undated, then alphabetical.
    const byDue = (a, b) => {
      const da = a.due ? localDateISO(a.due, tz) : ''
      const db = b.due ? localDateISO(b.due, tz) : ''
      if (da && db && da !== db) return da < db ? -1 : 1
      if (da && !db) return -1
      if (!da && db) return 1
      return (a.title || '').localeCompare(b.title || '')
    }
    const groups = []
    if (connected) {
      for (const a of taskAccounts) groups.push({
        id: a.connId, account: a.email || 'Google',
        lists: a.lists.map((l) => ({ id: l.id, title: l.title, tasks: gtasks.filter((t) => t.connId === a.connId && t.listId === l.id).filter(dueOk).filter(searchOk).map((t) => ({ ...t, source: 'google' })).sort(byDue) })),
      })
    }
    if (hasZoho && zoho) {
      const deals = zoho.crm?.deals || []
      const leads = zoho.crm?.leads || []
      const zprojects = zoho.projects || []
      const crmLists = []
      if (deals.length) crmLists.push({ id: 'deals', title: 'Deals', tasks: deals.map((d) => ({ id: d.id, title: d.title, sub: d.sub, status: 'needsAction', fields: d.fields || {}, open: d.open !== false, url: d.url, source: 'zoho' })).filter(searchOk) })
      if (leads.length) crmLists.push({ id: 'leads', title: 'Leads', tasks: leads.map((d) => ({ id: d.id, title: d.title, sub: d.sub, status: 'needsAction', fields: d.fields || {}, open: d.open !== false, url: d.url, source: 'zoho' })).filter(searchOk) })
      if (crmLists.length) groups.push({ id: 'zoho-crm', account: 'Zoho CRM', lists: crmLists, dealFields: zoho.crm?.dealFields || [], leadFields: zoho.crm?.leadFields || [] })
      if (zprojects.length) {
        // Derive filterable project fields (Status, Priority, Owner, Task List)
        // from the values actually present across all project tasks.
        const allTasks = zprojects.flatMap((p) => p.tasks || [])
        const projFieldKeys = [...new Set(allTasks.flatMap((t) => Object.keys(t.fields || {})))]
        const projectFields = projFieldKeys.map((k) => ({
          api_name: k, label: k,
          values: [...new Set(allTasks.map((t) => t.fields?.[k]).filter(Boolean))].sort(),
        })).filter((f) => f.values.length)
        groups.push({ id: 'zoho-projects', account: 'Zoho Projects', projectFields, lists: zprojects.map((p) => ({ id: p.id, title: p.name, tasks: (p.tasks || []).map((t) => ({ ...t, source: 'zoho' })).filter(searchOk) })) })
      }
    }
    return groups
  }, [connected, hasZoho, taskAccounts, gtasks, zoho, taskFilter, taskSearch, tz, today])

  // --- focus ----------------------------------------------------------------
  const focus = useMemo(() => {
    const todays = blocks[today] || []
    if (overrideBlockId) { const b = todays.find((x) => x.id === overrideBlockId); if (b) return computeFocus({ blocks: [b], meetings: [], buffers: [], now: b.start, projects }) }
    const m = connected ? (eventsByDate[today] || []) : []
    return computeFocus({ blocks: todays, meetings: m, buffers: buffersFrom(m), now, projects })
  }, [blocks, today, overrideBlockId, connected, eventsByDate, now, projects])

  function advanceToNext() {
    const todays = [...(blocks[today] || [])].sort((a, b) => a.start - b.start)
    const ref = overrideBlockId ? todays.find((b) => b.id === overrideBlockId)?.start ?? now : now
    const next = todays.find((b) => b.start > ref)
    if (next) setOverrideBlockId(next.id)
  }
  function applyTaskCompletion(task, completed) {
    const { connId, listId, id: taskId, source } = task
    const status = completed ? 'completed' : 'needsAction'
    const next = { ...blocks }
    for (const iso of Object.keys(next)) next[iso] = next[iso].map((b) => (Array.isArray(b.tasks) ? { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) } : b))
    updateBlocks(next)
    if (source === 'google') {
      setGtasks((cur) => (completed ? cur.filter((t) => t.id !== taskId) : cur.map((t) => (t.id === taskId ? { ...t, status } : t))))
      api.post('/api/google/data', { action: 'complete', connId, listId, taskId, completed }).catch(() => {})
    }
  }

  // --- create a block from a drop payload (start/end already collision-fit) --
  function blockFromPayload(payload, start, end) {
    if (payload.kind === 'project') return { id: uuid(), start, end, projectId: payload.projectId }
    if (payload.kind === 'task') return { id: uuid(), start, end, color: payload.color, tasks: [payload.task] }
    if (payload.kind === 'batch') return { id: uuid(), start, end, title: payload.title, color: payload.color || '#2563eb', tasks: payload.tasks }
    return null
  }

  // --- reminders ------------------------------------------------------------
  const [remState, setRemState] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  function enableReminders() {
    if (typeof Notification === 'undefined') return
    Notification.requestPermission().then((p) => { setRemState(p); if (p === 'granted') {
      const cur = nowMinutes(tz)
      for (const b of blocks[today] || []) { const delay = (b.start - cur) * 60000; if (delay <= 0 || delay > 12 * 3600000) continue; const name = b.title || projects.find((x) => x.id === b.projectId)?.name || 'Focus block'; setTimeout(() => new Notification('Focus Planner', { body: `${label(b.start)} — ${name}` }), delay) }
    } })
  }

  const blockColor = (b) => b.color || projects.find((p) => p.id === b.projectId)?.color || '#0b8043'
  const blockName = (b) => b.title || projects.find((p) => p.id === b.projectId)?.name || (b.tasks?.length === 1 ? b.tasks[0].title : `${b.tasks?.length || 0} tasks`)

  return (
    <div className={'app' + (sidebarOpen ? '' : ' sidebar-collapsed')}>
      <div className="scrim" onClick={() => setSidebarOpen(false)} />
      <Sidebar
        projects={projects} onNewProject={newProject} onEditProject={setEditProject} onDeleteProject={deleteProject}
        favorites={favorites} isFav={isFav} toggleFav={toggleFav}
        connected={connected} hasZoho={hasZoho} groups={displayGroups}
        taskFilter={taskFilter} setTaskFilter={setTaskFilter} taskSearch={taskSearch} setTaskSearch={setTaskSearch}
        collapsed={collapsed} setCollapsed={setCollapsed} sections={sections} setSections={setSections}
        connections={connections} onOpenSettings={openSettings}
        remState={remState} onEnableReminders={enableReminders}
        tz={tz} today={today}
        navCfg={navCfg}
        calAccounts={calAccounts} selectedCalendars={selectedCalendars} toggleCalendar={toggleCalendar}
      />

      <main className="main">
        <TopBar
          view={view} setView={setView} viewDate={viewDate} setViewDate={setViewDate} today={today}
          zoom={zoom} setZoom={setZoom} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)}
          planned={(dayBlocks(viewDate)).reduce((n, b) => n + (b.end - b.start), 0)}
        />
        {!storageOk && <div className="banner warn"><span className="banner-dot" />Reconnecting to storage — your changes are saved locally and will sync automatically.</div>}

        <div className="main-card">
        {view === 'day' && (
          <DayGrid
            day={viewDate} today={today} now={now} zoom={zoom}
            blocks={dayBlocks(viewDate)} meetings={meetingsFor(viewDate)} projects={projects}
            blockColor={blockColor} blockName={blockName}
            onCommit={(list) => setDayBlocks(viewDate, list)}
            onEdit={(b) => setEditBlock({ block: b, day: viewDate })}
            onDelete={(id) => deleteBlock(viewDate, id)}
            onCreateAt={(start, end) => { const b = { id: uuid(), start, end, title: 'Focus', color: ACCENT, tasks: [] }; addBlockTo(viewDate, b); setEditBlock({ block: b, day: viewDate }) }}
            onDropPayload={(payload, start, end) => { const b = blockFromPayload(payload, start, end); if (b) addBlockTo(viewDate, b) }}
            onOpenEvent={setViewEvent}
          />
        )}
        {view === 'week' && (
          <WeekGrid
            viewDate={viewDate} today={today} now={now} zoom={zoom} projects={projects}
            blocksByDay={blocks} meetingsFor={meetingsFor} blockColor={blockColor} blockName={blockName}
            onOpenDay={(d) => { setViewDate(d); setView('day') }}
            onEdit={(b, d) => setEditBlock({ block: b, day: d })}
            onCreateAt={(d, start, end) => { const b = { id: uuid(), start, end, title: 'Focus', color: ACCENT, tasks: [] }; addBlockTo(d, b); setEditBlock({ block: b, day: d }) }}
            onDropPayload={(d, payload, start, end) => { const b = blockFromPayload(payload, start, end); if (b) addBlockTo(d, b) }}
            onOpenEvent={setViewEvent}
          />
        )}
        {view === 'month' && (
          <MonthGrid
            viewDate={viewDate} today={today} blocksByDay={blocks} meetingsFor={meetingsFor}
            blockColor={blockColor} blockName={blockName}
            onOpenDay={(d) => { setViewDate(d); setView('day') }}
          />
        )}
        {!connected && !hasZoho && projects.length === 0 && Object.keys(blocks).length === 0 && (
          <div className="welcome-overlay">
            <div className="welcome-card">
              <div className="welcome-badge"><span className="dot" /></div>
              <h1 className="welcome-h">Design your day around deep work</h1>
              <p className="welcome-p">Bring your calendar and tasks together, then drag them onto the grid to block focused time. Your day, on purpose.</p>
              <div className="welcome-actions">
                <button className="btn primary lg" onClick={() => setShowConn(true)}><Icon name="link" size={16} /> Connect an account</button>
                <button className="btn lg" onClick={newProject}><Icon name="plus" size={16} /> Create a project</button>
              </div>
              <div className="welcome-tips">
                <div className="welcome-tip"><span className="wt-ic"><Icon name="calendar" size={15} /></span> Google Calendar, Tasks & Zoho in one view</div>
                <div className="welcome-tip"><span className="wt-ic"><Icon name="focus" size={15} /></span> A focus card shows what to work on now</div>
                <div className="welcome-tip"><span className="wt-ic"><Icon name="sliders" size={15} /></span> Press <kbd className="kbd">?</kbd> anytime for shortcuts</div>
              </div>
            </div>
          </div>
        )}
        </div>
      </main>

      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={'toast toast-' + t.kind}>
            <span className="toast-ic"><Icon name={t.kind === 'error' ? 'x' : t.kind === 'success' ? 'check' : 'bell'} size={15} strokeWidth={2.4} /></span>
            <span className="toast-msg">{t.msg}</span>
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon name="x" size={13} /></button>
          </div>
        ))}
      </div>

      {!focusHidden && (
        <FocusCard focus={focus} now={now}
          onToggleTask={(t) => applyTaskCompletion(t, t.status !== 'completed')}
          onOpenEvent={() => focus.event && setViewEvent(focus.event)}
          onNext={advanceToNext} onHide={() => setFocusHidden(true)} />
      )}
      {focusHidden && <button className="focus-show" onClick={() => setFocusHidden(false)}><Icon name="focus" size={15} /> Focus</button>}

      {editProject && <ProjectModal project={editProject} onSave={saveProject} onClose={() => setEditProject(null)} onDelete={deleteProject} />}
      {editBlock && (
        <BlockModal entry={editBlock} projects={projects}
          onSave={(b) => { updateBlock(editBlock.day, b); setEditBlock(null) }}
          onDelete={() => { deleteBlock(editBlock.day, editBlock.block.id); setEditBlock(null) }}
          onDuplicate={() => { duplicateBlock(editBlock.day, editBlock.block); setEditBlock(null) }}
          onClose={() => setEditBlock(null)} />
      )}
      {showConn && (
        <SettingsModal connections={connections} onDisconnect={disconnect}
          calAccounts={calAccounts} selectedCalendars={selectedCalendars} toggleCalendar={toggleCalendar}
          taskAccounts={taskAccounts} selectedTaskLists={selectedTaskLists} toggleTaskList={toggleTaskList}
          navCfg={navCfg} onNavChange={updateNavCfg} groups={displayGroups} connected={connected} hasZoho={hasZoho}
          zoom={zoom} setZoom={setZoom} tz={tz} onChangeTz={(v) => { setTz(v); saveKey('timezone', v) }}
          focusHidden={focusHidden} setFocusHidden={setFocusHidden} remState={remState} onEnableReminders={enableReminders}
          theme={theme} setTheme={setTheme} initialTab={settingsTab}
          zohoErrors={zoho?.errors} onClose={() => setShowConn(false)} />
      )}
      {showHelp && <ShortcutsModal onClose={() => setShowHelp(false)} />}
      {showCmd && <CommandPalette onClose={() => setShowCmd(false)} actions={[
        { id: 'today', label: 'Go to Today', icon: 'calendar', hint: 'T', run: () => setViewDate(today) },
        { id: 'day', label: 'Day view', icon: 'calendar', hint: 'D', run: () => setView('day') },
        { id: 'week', label: 'Week view', icon: 'calendar', hint: 'W', run: () => setView('week') },
        { id: 'month', label: 'Month view', icon: 'calendar', hint: 'M', run: () => setView('month') },
        { id: 'prev', label: 'Previous', icon: 'chevronLeft', run: () => setViewDate((v) => (view === 'month' ? addMonths(v, -1) : addDays(v, view === 'week' ? -7 : -1))) },
        { id: 'next', label: 'Next', icon: 'chevronRight', run: () => setViewDate((v) => (view === 'month' ? addMonths(v, 1) : addDays(v, view === 'week' ? 7 : 1))) },
        { id: 'newproj', label: 'New project', icon: 'plus', run: newProject },
        { id: 'focus', label: focusHidden ? 'Show focus card' : 'Hide focus card', icon: 'focus', run: () => setFocusHidden((h) => !h) },
        { id: 'sidebar', label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar', icon: 'sidebar', run: () => setSidebarOpen((v) => !v) },
        { id: 'settings', label: 'Open Settings', icon: 'settings', run: () => setShowConn(true) },
        { id: 'help', label: 'Keyboard shortcuts', icon: 'sliders', hint: '?', run: () => setShowHelp(true) },
      ]} />}
      {viewEvent && <EventModal event={viewEvent} onClose={() => setViewEvent(null)} />}
    </div>
  )
}

/* ========================================================================== */

function TopBar({ view, setView, viewDate, setViewDate, today, zoom, setZoom, sidebarOpen, onToggleSidebar, planned }) {
  const plannedLabel = planned ? (planned >= 60 ? `${Math.floor(planned / 60)}h${planned % 60 ? ' ' + (planned % 60) + 'm' : ''}` : `${planned}m`) : ''
  const step = view === 'week' ? 7 : view === 'month' ? 30 : 1
  const d = new Date(viewDate + 'T12:00:00')
  let title
  if (view === 'month') title = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  else if (view === 'week') { const w = weekDays(viewDate); const a = new Date(w[0] + 'T12:00:00'); const b = new Date(w[6] + 'T12:00:00'); title = `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` }
  else title = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const gotoMonth = (n) => setViewDate(addMonths(viewDate, n))
  return (
    <div className="topbar">
      <button className="icon-btn" title="Toggle sidebar" onClick={onToggleSidebar}><Icon name="sidebar" size={18} /></button>
      <button className="btn" onClick={() => setViewDate(today)}>Today</button>
      <div className="nav-group">
        <button className="icon-btn" title="Previous" onClick={() => (view === 'month' ? gotoMonth(-1) : setViewDate(addDays(viewDate, -step)))}><Icon name="chevronLeft" size={18} /></button>
        <button className="icon-btn" title="Next" onClick={() => (view === 'month' ? gotoMonth(1) : setViewDate(addDays(viewDate, step)))}><Icon name="chevronRight" size={18} /></button>
      </div>
      <span className="today-date">{title}</span>
      {view === 'day' && plannedLabel && <span className="planned-chip" title="Time planned today">{plannedLabel} planned</span>}
      <div className="spacer" />
      {view !== 'month' && (
        <div className="density">
          <span className="lbl">Density</span>
          <input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </div>
      )}
      <div className="seg">
        {['day', 'week', 'month'].map((v) => (
          <button key={v} className={'seg-btn' + (view === v ? ' on' : '')} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
        ))}
      </div>
    </div>
  )
}

/* ---- Day grid (full drag / resize / click-create) ---- */
function DayGrid({ day, today, now, zoom, blocks, meetings, blockColor, blockName, onCommit, onEdit, onDelete, onCreateAt, onDropPayload, onOpenEvent }) {
  const ref = useRef(null)
  const scrollRef = useRef(null)
  const drag = useRef(null)
  const latest = useRef(blocks)
  const [localBlocks, setLocalBlocks] = useState(blocks)
  const [hint, setHint] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [hover, setHover] = useState(null) // ghost "add block" affordance on empty hover
  useEffect(() => { latest.current = blocks; setLocalBlocks(blocks) }, [blocks])
  // Open the day at 8 AM (top of the working window) by default.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (VIEW_START - DAY_START) * zoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const buffers = useMemo(() => buffersFrom(meetings), [meetings])
  const height = (DAY_END - DAY_START) * zoom
  const hours = []; for (let h = DAY_START; h <= DAY_END; h += 60) hours.push(h)
  const yToMin = (clientY) => clamp(snap(DAY_START + (clientY - ref.current.getBoundingClientRect().top) / zoom), DAY_START, DAY_END - SNAP_MIN)

  const occFor = (excludeId) => [...meetings, ...buffers, ...latest.current.filter((b) => b.id !== excludeId)]

  function onPointerDown(e, block, mode) {
    e.stopPropagation(); e.preventDefault()
    drag.current = { id: block.id, mode, startY: e.clientY, orig: { ...block }, moved: false }
    setDraggingId(block.id)
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }
  function onMove(e) {
    const dd = drag.current; if (!dd) return
    if (Math.abs(e.clientY - dd.startY) > 4) dd.moved = true
    const dMin = snap((e.clientY - dd.startY) / zoom)
    const others = occFor(dd.id)
    let target = null
    const list = latest.current.map((b) => {
      if (b.id !== dd.id) return b
      if (dd.mode === 'move') {
        const len = dd.orig.end - dd.orig.start
        const r = clampMove(others, clamp(dd.orig.start + dMin, DAY_START, DAY_END - len), len)
        target = r ? { ...b, start: r.start, end: r.end } : b
        return target
      }
      if (dd.mode === 'resize-top') { target = { ...b, start: clampResizeTop(others, dd.orig.end, dd.orig.start + dMin) }; return target }
      target = { ...b, end: clampResizeBottom(others, dd.orig.start, dd.orig.end + dMin) }; return target
    })
    latest.current = list; setLocalBlocks(list)
    if (dd.moved && target) setHint({ start: target.start, end: target.end }) // landing highlight
  }
  function onUp() {
    const dd = drag.current; drag.current = null
    setDraggingId(null); setHint(null)
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
    if (dd && dd.moved) onCommit(latest.current)
    else if (dd) { const b = blocks.find((x) => x.id === dd.id); if (b) onEdit(b) }
  }

  const occAll = () => [...meetings, ...buffers, ...latest.current]

  return (
    <div className="cal-scroll" ref={scrollRef}>
      <div className="grid" ref={ref} style={{ height }}
        onDoubleClick={(e) => { if (e.target === ref.current) { const s = fitDrop(occAll(), yToMin(e.clientY), 60); if (s) onCreateAt(s.start, s.end) } }}
        onMouseMove={(e) => { if (drag.current) return; const t = e.target; const empty = t === ref.current || t.classList?.contains('hour-row') || t.classList?.contains('hour-label'); if (empty) { const s = fitDrop(occAll(), yToMin(e.clientY), 60); setHover(s) } else if (hover) setHover(null) }}
        onMouseLeave={() => setHover(null)}
        onDragOver={(e) => { e.preventDefault(); setHover(null); const s = fitDrop(occAll(), yToMin(e.clientY), 60); setHint(s || { start: yToMin(e.clientY), end: yToMin(e.clientY) + SNAP_MIN, none: true }) }}
        onDragLeave={(e) => { if (e.target === ref.current) setHint(null) }}
        onDrop={(e) => { e.preventDefault(); const s = fitDrop(occAll(), yToMin(e.clientY), 60); setHint(null); if (s) { try { onDropPayload(JSON.parse(e.dataTransfer.getData('application/json')), s.start, s.end) } catch {} } }}>
        {hours.map((h) => (
          <React.Fragment key={h}>
            <div className="hour-row" style={{ top: (h - DAY_START) * zoom }}><span className="hour-label">{hourLabel(h)}</span></div>
            {h + 30 < DAY_END && zoom > 1.2 && <div className="hour-row half" style={{ top: (h + 30 - DAY_START) * zoom }} />}
          </React.Fragment>
        ))}
        {hover && !hint && !draggingId && (
          <div className="create-ghost" style={{ top: (hover.start - DAY_START) * zoom, height: (hover.end - hover.start) * zoom }}>
            <span><Icon name="plus" size={13} /> Double-click to block time</span>
          </div>
        )}
        {hint && <div className={'drop-hint' + (hint.none ? ' invalid' : '')} style={{ top: (hint.start - DAY_START) * zoom, height: (hint.end - hint.start) * zoom }}>{hint.none ? 'No room' : `${label(hint.start)} – ${label(hint.end)}`}</div>}
        {buffers.map((b, i) => <div key={'b' + i} className="ev ev-buffer" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 8, right: 10 }}>Prep · {b.forTitle}</div>)}
        {meetings.map((m) => { const mh = (m.end - m.start) * zoom; return (
          <div key={m.id} className="ev ev-meeting" style={{ top: (m.start - DAY_START) * zoom, height: mh, left: 8, right: 10 }} title={m.title}
            onClick={() => onOpenEvent && onOpenEvent(m)}>
            {m.link && <span className="ev-cam" title="Has a video link"><Icon name="video" size={12} /></span>}
            {mh < 40
              ? <div className="ev-line"><span className="ev-title">{m.title}</span><span className="ev-time">{labelShort(m.start)}</span></div>
              : <><div className="ev-title">{m.title}</div><div className="ev-time">{label(m.start)} – {label(m.end)}</div></>}
          </div>
        ) })}
        {localBlocks.map((b) => {
          const bh = (b.end - b.start) * zoom
          const short = bh < 40
          const hasTasks = Array.isArray(b.tasks) && b.tasks.length > 0
          return (
            <div key={b.id} className={'ev ev-block' + (draggingId === b.id ? ' dragging' : '')} style={{ top: (b.start - DAY_START) * zoom, height: bh, left: 8, right: 10, background: blockColor(b) }}
              onPointerDown={(e) => onPointerDown(e, b, 'move')}>
              <div className="ev-resize-top" onPointerDown={(e) => onPointerDown(e, b, 'resize-top')} />
              <button className="ev-del" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(b.id) }}><Icon name="x" size={12} /></button>
              {short
                ? <div className="ev-line"><span className="ev-title">{blockName(b)}</span><span className="ev-time">{labelShort(b.start)}</span></div>
                : <>
                    <div className="ev-title">{blockName(b)}</div>
                    <div className="ev-time">{label(b.start)} – {label(b.end)}</div>
                    {hasTasks && bh > 64 && <div className="ev-tasklist">{b.tasks.slice(0, 4).map((t) => <div key={t.id} className={'ev-task' + (t.status === 'completed' ? ' done' : '')}>• {t.title}</div>)}</div>}
                  </>}
              <div className="ev-resize" onPointerDown={(e) => onPointerDown(e, b, 'resize')} />
            </div>
          )
        })}
        {day === today && now >= DAY_START && now <= DAY_END && <div className="now-line" style={{ top: (now - DAY_START) * zoom }}><span className="now-chip">{label(now)}</span><span className="now-dot" /></div>}
      </div>
    </div>
  )
}

/* ---- Week grid ---- */
function WeekGrid({ viewDate, today, now, zoom, projects, blocksByDay, meetingsFor, blockColor, blockName, onOpenDay, onEdit, onCreateAt, onDropPayload, onOpenEvent }) {
  const days = weekDays(viewDate)
  const height = (DAY_END - DAY_START) * zoom
  const hours = []; for (let h = DAY_START; h <= DAY_END; h += 60) hours.push(h)
  const colRefs = useRef({})
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (VIEW_START - DAY_START) * zoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const yToMin = (day, clientY) => clamp(snap(DAY_START + (clientY - colRefs.current[day].getBoundingClientRect().top) / zoom), DAY_START, DAY_END - SNAP_MIN)
  return (
    <div className="cal-scroll" ref={scrollRef}>
      <div className="week-colhead">
        <div />
        {days.map((d) => { const dd = new Date(d + 'T12:00:00'); return (
          <div key={d} className={'wch' + (d === today ? ' is-today' : '')} onClick={() => onOpenDay(d)} style={{ cursor: 'pointer' }}>
            <div className="dow">{dd.toLocaleDateString('en-US', { weekday: 'short' })}</div>
            <div className="num">{dd.getDate()}</div>
          </div>
        ) })}
      </div>
      <div className="week-body" style={{ height }}>
        <div className="week-axis">
          {hours.map((h) => <div key={h} className="hour-row" style={{ top: (h - DAY_START) * zoom, left: 0, right: 'auto', width: 52, borderTop: 'none' }}><span className="hour-label">{hourLabel(h)}</span></div>)}
        </div>
        <div className="week-cols">
          {days.map((d) => {
            const meetings = meetingsFor(d); const buffers = buffersFrom(meetings); const bl = blocksByDay[d] || []
            return (
              <div key={d} className={'week-col' + (d === today ? ' is-today' : '')} ref={(el) => (colRefs.current[d] = el)}
                onDoubleClick={(e) => { if (e.currentTarget === e.target) { const s = fitDrop([...meetings, ...buffers, ...bl], yToMin(d, e.clientY), 60); if (s) onCreateAt(d, s.start, s.end) } }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const s = fitDrop([...meetings, ...buffers, ...bl], yToMin(d, e.clientY), 60); if (s) { try { onDropPayload(d, JSON.parse(e.dataTransfer.getData('application/json')), s.start, s.end) } catch {} } }}>
                {hours.map((h) => <div key={h} className="hour-row" style={{ top: (h - DAY_START) * zoom, left: 0 }} />)}
                {buffers.map((b, i) => <div key={'b' + i} className="ev ev-buffer" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 2, right: 2 }} />)}
                {meetings.map((m) => <div key={m.id} className="ev ev-meeting" style={{ top: (m.start - DAY_START) * zoom, height: (m.end - m.start) * zoom, left: 2, right: 2 }} title={`${m.title} · ${label(m.start)}`} onClick={(e) => { e.stopPropagation(); onOpenEvent && onOpenEvent(m) }}><div className="ev-title">{m.title}</div>{(m.end - m.start) * zoom > 28 && <div className="ev-time">{label(m.start)}</div>}</div>)}
                {bl.map((b) => <div key={b.id} className="ev ev-block" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 2, right: 2, background: blockColor(b) }} onClick={(e) => { e.stopPropagation(); onEdit(b, d) }} title={`${blockName(b)} · ${label(b.start)}`}><div className="ev-title">{blockName(b)}</div>{(b.end - b.start) * zoom > 28 && <div className="ev-time">{label(b.start)}</div>}</div>)}
                {d === today && now >= DAY_START && now <= DAY_END && <div className="now-line" style={{ top: (now - DAY_START) * zoom, left: 0 }}><span className="now-dot" /></div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ---- Month grid ---- */
function MonthGrid({ viewDate, today, blocksByDay, meetingsFor, blockColor, blockName, onOpenDay }) {
  const cells = monthGridDays(viewDate); const cur = monthOf(viewDate)
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return (
    <div className="month">
      <div className="month-dowrow">{dows.map((d) => <div key={d} className="month-dow">{d}</div>)}</div>
      <div className="month-grid">
        {cells.map((d) => {
          const bl = blocksByDay[d] || []; const meetings = meetingsFor(d)
          const items = [...meetings.map((m) => ({ meeting: true, title: m.title, start: m.start })), ...bl.map((b) => ({ title: blockName(b), color: blockColor(b), start: b.start }))].sort((a, b) => a.start - b.start)
          return (
            <div key={d} className={'mcell' + (monthOf(d) !== cur ? ' out' : '') + (d === today ? ' is-today' : '')} onClick={() => onOpenDay(d)}>
              <div className="mcell-num">{dayNum(d)}</div>
              {items.slice(0, 3).map((it, i) => <div key={i} className={'mchip' + (it.meeting ? ' meeting' : '')} style={it.meeting ? undefined : { background: it.color }}>{it.title}</div>)}
              {items.length > 3 && <div className="mmore">+{items.length - 3} more</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---- Sidebar ---- */
function Sidebar(props) {
  const {
    projects, onNewProject, onEditProject, onDeleteProject, favorites, isFav, toggleFav, connected, hasZoho, groups,
    taskFilter, setTaskFilter, taskSearch, setTaskSearch, collapsed, setCollapsed,
    connections, onOpenSettings, remState, onEnableReminders, tz, today, navCfg,
    calAccounts, selectedCalendars, toggleCalendar,
  } = props
  const [secOpen, setSecOpen] = useState({})
  const isOpen = (id, def = true) => (secOpen[id] === undefined ? def : secOpen[id])
  const tog = (id, def = true) => setSecOpen((o) => ({ ...o, [id]: !isOpen(id, def) }))
  function dueBadge(due) {
    if (!due) return null
    const iso = localDateISO(due, tz)
    if (!iso) return null
    const overdue = iso < today
    const isToday = iso === today
    if (!overdue && !isToday) { // future
      const d = new Date(iso + 'T12:00:00')
      const daysOut = (d - new Date(today + 'T12:00:00')) / 86400000
      if (daysOut > 7) return null // only surface due dates within a week
      return <span className="due-badge">{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
    }
    return <span className={'due-badge' + (overdue ? ' overdue' : ' today')}>{overdue ? 'Overdue' : 'Today'}</span>
  }
  function chip(e, text, color) {
    const el = document.createElement('div')
    el.className = 'drag-chip'
    if (color) el.style.setProperty('--chip', color)
    el.textContent = text
    document.body.appendChild(el)
    e.dataTransfer.setDragImage(el, 12, 12)
    setTimeout(() => el.remove(), 0)
  }
  const dragProject = (e, p) => { e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'project', projectId: p.id })); chip(e, p.name, p.color) }
  const dragTask = (e, task, g, l) => { const color = srcColor(navCfg, g.id); e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'task', color, task: { ...task, connId: g.id, listId: l.id } })); chip(e, task.title, color) }
  const dragBatch = (e, g, l, only) => { const color = srcColor(navCfg, g.id); const tasks = (only || l.tasks).filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: g.id, listId: l.id })); e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'batch', color, title: l.title, tasks })); chip(e, `${l.title} · ${tasks.length}`, color) }
  const dragFav = (e, f) => { e.dataTransfer.setData('application/json', JSON.stringify(f.payload)); chip(e, f.label, f.color) }

  const projEntry = (p) => ({ id: 'p:' + p.id, kind: 'project', label: p.name, color: p.color, projectId: p.id, payload: { kind: 'project', projectId: p.id } })
  const taskEntry = (t, g, l) => { const color = srcColor(navCfg, g.id); return { id: `t:${g.id}:${l.id}:${t.id}`, kind: 'task', label: t.title, color, payload: { kind: 'task', color, task: { ...t, connId: g.id, listId: l.id } } } }
  // Favorite an entire list (Deals, Leads, a project, a Google list) as a batch
  // block — this is how you "drag CRM as a block", not just individual records.
  const listFavId = (g, l) => `zb:${g.id}:${l.id}`
  const batchEntry = (g, l, tasks) => { const color = srcColor(navCfg, g.id); return {
    id: listFavId(g, l),
    kind: g.id === 'zoho-crm' ? 'crm' : g.id === 'zoho-projects' ? 'zohoproject' : 'tasklist',
    label: l.title,
    color,
    payload: { kind: 'batch', color, title: l.title, tasks: (tasks || l.tasks).filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: g.id, listId: l.id })) },
  } }
  const favIcon = (k) => (k === 'project' ? 'folder' : k === 'zohoproject' || k === 'crm' || k === 'tasklist' ? 'list' : 'check')

  // --- apply the saved "Customize nav bar" settings ------------------------
  const mods = navCfg.modules || {}
  const moduleOn = (g, l) => {
    if (!g.id.startsWith('zoho')) return mods.google !== false
    if (g.id === 'zoho-projects') return mods.projects !== false
    if (g.id === 'zoho-crm') return l.id === 'deals' ? mods.deals !== false : mods.leads !== false
    return true
  }
  // A record passes a module's filters when it matches EVERY rule (AND). Each
  // rule matches when the record's value for that field is one of the selected
  // values. No rules = show everything.
  const filters = navCfg.filters || {}
  const passesFilters = (t, rules) => !rules || rules.every((r) => !r.values?.length || r.values.includes(t.fields?.[r.field]))
  const listTasks = (g, l) => {
    let ts = l.tasks
    if (g.id === 'zoho-crm' && l.id === 'deals') ts = ts.filter((t) => passesFilters(t, filters.deals))
    if (g.id === 'zoho-crm' && l.id === 'leads') ts = ts.filter((t) => passesFilters(t, filters.leads))
    if (g.id === 'zoho-projects') {
      if (navCfg.zohoAssignee !== 'all') ts = ts.filter((t) => t.mine !== false)
      ts = ts.filter((t) => passesFilters(t, filters.projects))
    }
    return ts
  }
  const visibleGroups = groups
    .map((g) => ({ ...g, lists: g.lists.filter((l) => moduleOn(g, l)) }))
    .filter((g) => g.lists.length)
  const taskCount = visibleGroups.reduce((a, g) => a + g.lists.reduce((b, l) => b + listTasks(g, l).length, 0), 0)

  // Meta (color / icon / settings tab / title) for a connected-source section.
  const groupMeta = (g) => {
    const color = srcColor(navCfg, g.id)
    if (g.id === 'zoho-crm') return { color, icon: 'list', title: 'Zoho CRM', tab: 'crm' }
    if (g.id === 'zoho-projects') return { color, icon: 'folder', title: 'Zoho Projects', tab: 'projects' }
    return { color, icon: 'check', title: 'Google Tasks', tab: 'gtasks' }
  }
  const calAcc = (calAccounts || []).filter((a) => (a.calendars || []).length)
  const hasCal = calAcc.length > 0

  // Renders the lists+tasks inside a connected-source section.
  const renderGroup = (g) => g.lists.map((l) => {
    const key = g.id + '/' + l.id
    const col = collapsed[key] === undefined ? true : collapsed[key]
    const tasks = listTasks(g, l)
    const favId = listFavId(g, l)
    return (
      <div key={l.id}>
        <div className="tlist-head" draggable onDragStart={(e) => dragBatch(e, g, l, tasks)}>
          <button className="caret" onClick={() => setCollapsed({ ...collapsed, [key]: !col })}><Icon name={col ? 'chevronRight' : 'chevronDown'} size={15} /></button>
          <span className="tlist-title">{l.title}</span>
          <button className={'star' + (isFav(favId) ? ' on' : '')} title="Favorite this list as a block" onClick={(e) => { e.stopPropagation(); toggleFav(batchEntry(g, l, tasks)) }}><Icon name="star" size={14} filled={isFav(favId)} /></button>
          <span className="tlist-count">{tasks.length}</span>
        </div>
        {!col && tasks.map((t) => {
          const tid = `t:${g.id}:${l.id}:${t.id}`
          return (
            <div key={t.id} className="titem" draggable onDragStart={(e) => dragTask(e, t, g, l)}>
              <span className="tdot" />
              <span className="titem-body">{t.title}{t.sub ? <div className="tsub">{t.sub}</div> : null}</span>
              {dueBadge(t.due)}
              <button className={'star' + (isFav(tid) ? ' on' : '')} title="Favorite" onClick={(e) => { e.stopPropagation(); toggleFav(taskEntry(t, g, l)) }}><Icon name="star" size={14} filled={isFav(tid)} /></button>
            </div>
          )
        })}
        {!col && tasks.length === 0 && <div className="muted tlist-empty">{g.id === 'zoho-projects' && navCfg.zohoAssignee !== 'all' ? 'None assigned to you' : 'Empty'}</div>}
      </div>
    )
  })

  return (
    <aside className="sidebar">
      <div className="brand"><span className="dot" /> Focus Planner</div>

      {favorites.length > 0 && (
        <div className="sb-pinned">
          <div className="sbx-label"><span className="sbx-label-ic" style={{ '--c': '#f5b301' }}><Icon name="star" size={12} filled /></span> Favorites <span className="sbx-count">{favorites.length}</span></div>
          <div className="fav-grid">
            {favorites.map((f) => (
              <div key={f.id} className="fav-card" style={{ background: f.color }} draggable onDragStart={(e) => dragFav(e, f)}
                onClick={() => { if (f.kind === 'project') { const p = projects.find((x) => x.id === f.projectId); if (p) onEditProject(p) } }}>
                <span className="fav-ic"><Icon name={favIcon(f.kind)} size={14} /></span>
                <span className="fav-name">{f.label}</span>
                <button className="fav-x" title="Unfavorite" onClick={(e) => { e.stopPropagation(); toggleFav(f) }}><Icon name="star" size={13} filled /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sb-scroll">
        {hasCal && (
          <SbSection id="calendar" color="#0f9d58" icon="calendar" title="Calendar" count={calAcc.reduce((n, a) => n + a.calendars.filter((c) => selectedCalendars.includes(`${a.connId}::${c.id}`)).length, 0)}
            open={isOpen('calendar')} onToggle={() => tog('calendar')} onSettings={() => onOpenSettings('calendar')}>
            {calAcc.map((a) => a.calendars.map((c) => { const k = `${a.connId}::${c.id}`; const on = selectedCalendars.includes(k); return (
              <button key={k} className={'cal-toggle' + (on ? ' on' : '')} onClick={() => toggleCalendar(k)}>
                <span className="cal-dot" style={{ background: on ? (c.color || '#0f9d58') : 'transparent', borderColor: c.color || '#0f9d58' }} />
                <span className="cal-name">{c.summary}</span>
              </button>
            ) }))}
          </SbSection>
        )}

        <div className="sbx-label"><span className="sbx-label-ic" style={{ '--c': 'var(--accent)' }}><Icon name="sidebar" size={12} /></span> Blocks</div>

        <SbSection id="custom" color="#7c3aed" icon="folder" title="Custom" count={projects.length || null}
          open={isOpen('custom')} onToggle={() => tog('custom')}>
          <div className="proj-list">
            {projects.map((p) => (
              <div key={p.id} className="proj-row" draggable onDragStart={(e) => dragProject(e, p)}>
                <span className="swatch" style={{ background: p.color }} />
                <span className="proj-name" onClick={() => onEditProject(p)}>{p.name}</span>
                <button className={'star' + (isFav('p:' + p.id) ? ' on' : '')} title="Favorite" onClick={() => toggleFav(projEntry(p))}><Icon name="star" size={14} filled={isFav('p:' + p.id)} /></button>
                <button className="row-x" title="Delete" onClick={() => onDeleteProject(p.id)}><Icon name="x" size={14} /></button>
              </div>
            ))}
            {projects.length === 0 && <div className="muted" style={{ padding: '2px 8px 6px' }}>Add a project and drag it onto the grid to block time.</div>}
          </div>
          <button className="btn new-proj" onClick={onNewProject}><Icon name="plus" size={15} /> New project</button>
        </SbSection>

        {(connected || hasZoho) && (visibleGroups.length > 0) && (
          <div className="task-search"><Icon name="search" size={15} className="search-ic" /><input className="field" placeholder="Search tasks…" value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} /></div>
        )}

        {visibleGroups.map((g) => {
          const m = groupMeta(g)
          const cnt = g.lists.reduce((n, l) => n + listTasks(g, l).length, 0)
          return (
            <SbSection key={g.id} id={g.id} color={m.color} icon={m.icon} title={m.title} count={cnt}
              open={isOpen(g.id)} onToggle={() => tog(g.id)} onSettings={() => onOpenSettings(m.tab)}>
              {renderGroup(g)}
            </SbSection>
          )
        })}

        {!connected && !hasZoho && (
          <div className="empty-hint">No accounts connected yet.<br /><button className="link" onClick={() => onOpenSettings('connections')}>Connect Google or Zoho</button> to pull in tasks, deals & projects.</div>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn conn-btn" onClick={() => onOpenSettings('connections')}>
          <span className="gear"><Icon name="settings" size={15} /></span> Settings
        </button>
      </div>
    </aside>
  )
}

// A collapsible sidebar section: colored icon chip, title, count, hover gear.
function SbSection({ id, color, icon, title, count, open, onToggle, onSettings, children }) {
  return (
    <div className={'sbx' + (open ? ' open' : '')}>
      <div className="sbx-head" onClick={onToggle}>
        <span className="sbx-ic" style={{ '--c': color }}><Icon name={icon} size={14} /></span>
        <span className="sbx-title">{title}</span>
        {count != null && <span className="sbx-count">{count}</span>}
        {onSettings && <button className="sbx-gear" title="Settings" onClick={(e) => { e.stopPropagation(); onSettings() }}><Icon name="settings" size={14} /></button>}
        <span className="sbx-caret"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /></span>
      </div>
      {open && <div className="sbx-body">{children}</div>}
    </div>
  )
}

/* ---- Modals ---- */
function GoogleIcon({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}
function ZohoIcon({ size = 26 }) {
  // Zoho brandmark: four color blocks + red "ZOHO" wordmark stacked into a square.
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <rect width="48" height="48" rx="10" fill="#fff" stroke="#eceff3" />
      <g transform="translate(9 15)">
        <rect x="0" y="0" width="6" height="9" rx="1.5" fill="#226DB4" />
        <rect x="8" y="0" width="6" height="9" rx="1.5" fill="#E42527" />
        <rect x="16" y="0" width="6" height="9" rx="1.5" fill="#F9B21D" />
        <rect x="24" y="0" width="6" height="9" rx="1.5" fill="#089949" />
      </g>
      <text x="24" y="34" textAnchor="middle" fontSize="8" fontWeight="800" fill="#3a4256" fontFamily="Inter, Arial">ZOHO</text>
    </svg>
  )
}
function ProviderIcon({ provider, size }) { return provider === 'zoho' ? <ZohoIcon size={size} /> : <GoogleIcon size={size} /> }

// A color picker row for a connector's block color.
function ColorRow({ label, k, cur, onPick }) {
  const active = cur(k)
  return (
    <div className="cz-mod" style={{ padding: '11px 14px' }}>
      <div className="cz-mod-name" style={{ marginBottom: 9 }}>{label}</div>
      <div className="swatches">
        {COLOR_CHOICES.map((c) => (
          <button key={c} className={'swatch-btn' + (active.toLowerCase() === c.toLowerCase() ? ' on' : '')} style={{ background: c }} onClick={() => onPick(k, c)} aria-label={c} />
        ))}
      </div>
    </div>
  )
}

// One iOS-style row: label + on/off switch.
function SettingRow({ label, sub, on, onClick }) {
  return (
    <div className="set-row">
      <div><div className="set-row-label">{label}</div>{sub && <div className="set-row-sub">{sub}</div>}</div>
      <Switch on={on} onClick={onClick} />
    </div>
  )
}

// A module block with an on/off header and, when on, its filter builder.
function ModuleBlock({ name, on, onToggle, opts, rules, onRules, extra, emptyHint }) {
  return (
    <div className="cz-mod">
      <div className="cz-mod-head"><span className="cz-mod-name">{name}</span><Switch on={on} onClick={onToggle} /></div>
      {on && (opts || extra) && (
        <div className="cz-mod-body">
          {opts ? <FilterBuilder opts={opts} rules={rules} onChange={onRules} extra={extra} emptyHint={emptyHint} /> : extra}
        </div>
      )}
    </div>
  )
}

// Full-screen Settings: left category nav + one scrolling content pane. No nested popups.
function SettingsModal(props) {
  const {
    connections, onDisconnect, calAccounts, selectedCalendars, toggleCalendar,
    taskAccounts, selectedTaskLists, toggleTaskList, navCfg, onNavChange, groups, connected, hasZoho,
    zoom, setZoom, tz, onChangeTz, focusHidden, setFocusHidden, remState, onEnableReminders, theme, setTheme, initialTab, zohoErrors, onClose,
  } = props
  const googleHasTasks = connections.some((c) => c.provider === 'google' && (c.extra?.features || ['calendar', 'tasks']).includes('tasks'))
  const cats = [
    { id: 'connections', label: 'Connections', icon: 'link' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'focus', label: 'Focus & reminders', icon: 'bell' },
    { id: 'general', label: 'General', icon: 'sliders' },
  ]
  // Per-source settings (gtasks/crm/projects) live inside each connection now.
  const googleConn = connections.find((c) => c.provider === 'google')
  const zohoConn = connections.find((c) => c.provider === 'zoho')
  const tabFor = (t) => (cats.some((c) => c.id === t) ? t : (['gtasks', 'crm', 'projects'].includes(t) ? 'connections' : 'connections'))
  const [tab, setTab] = useState(tabFor(initialTab))
  const [expanded, setExpanded] = useState(() => {
    if (initialTab === 'gtasks') return googleConn?.id
    if (initialTab === 'crm' || initialTab === 'projects') return zohoConn?.id
    return null
  })
  const [addGoogle, setAddGoogle] = useState(false)
  const [gfeats, setGfeats] = useState({ calendar: true, tasks: true })
  const curColor = (k) => navCfg.colors?.[k] || DEFAULT_COLORS[k]
  const setColor = (k, c) => onNavChange({ ...navCfg, colors: { ...(navCfg.colors || {}), [k]: c } })

  const mods = navCfg.modules || {}
  const filters = navCfg.filters || { deals: [], leads: [], projects: [] }
  const setMod = (k, v) => onNavChange({ ...navCfg, modules: { ...mods, [k]: v } })
  const setRules = (key, rules) => onNavChange({ ...navCfg, filters: { ...filters, [key]: rules } })
  const crm = groups?.find((g) => g.id === 'zoho-crm')
  const projGroup = groups?.find((g) => g.id === 'zoho-projects')
  const dealOpts = fieldOptsFrom(crm?.dealFields, crm?.lists.find((l) => l.id === 'deals')?.tasks)
  const leadOpts = fieldOptsFrom(crm?.leadFields, crm?.lists.find((l) => l.id === 'leads')?.tasks)
  const projOpts = fieldOptsFrom(projGroup?.projectFields, (projGroup?.lists || []).flatMap((l) => l.tasks))
  const crmError = (zohoErrors || []).find((e) => /^(deals|leads|auth)/i.test(e))
  const projError = (zohoErrors || []).find((e) => /^(projects|tasks|auth)/i.test(e))

  const TZ = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney', 'UTC']
  const tzList = TZ.includes(tz) ? TZ : [tz, ...TZ]

  const googleAcct = connections.find((c) => c.provider === 'google' && (c.extra?.features || ['calendar']).includes('calendar'))
  const addHref = `/api/google/start?feats=${[gfeats.calendar && 'calendar', gfeats.tasks && 'tasks'].filter(Boolean).join(',') || 'tasks'}`

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="set-nav">
          <div className="set-nav-title">Settings</div>
          {cats.map((c) => (
            <button key={c.id} className={'set-nav-item' + (tab === c.id ? ' on' : '')} onClick={() => setTab(c.id)}>
              <Icon name={c.icon} size={16} /> {c.label}
            </button>
          ))}
        </nav>
        <div className="set-main">
          <div className="set-head">
            <div className="set-head-title">{cats.find((c) => c.id === tab)?.label}</div>
            <button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
          <div className="set-content">

            {tab === 'connections' && (
              <>
                {connections.length > 0 && <div className="set-group">
                  <div className="set-group-title">Connected accounts</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 10 }}>Click an account to configure what it syncs, its filters, and its color.</div>
                  {connections.map((c) => {
                    const isZoho = c.provider === 'zoho'
                    const open = expanded === c.id
                    return (
                      <div key={c.id} className={'set-acct-card' + (open ? ' open' : '')}>
                        <div className="set-acct" onClick={() => setExpanded(open ? null : c.id)}>
                          <div className="conn-logo"><ProviderIcon provider={c.provider} /></div>
                          <div className="set-acct-body">
                            <div className="set-acct-title">{c.account_label || c.account_email || (isZoho ? 'Zoho' : 'Google')}</div>
                            <div className="set-acct-sub">{(c.provider === 'google' ? (c.extra?.features || ['calendar', 'tasks']) : ['deals', 'leads', 'projects']).map((f) => f[0].toUpperCase() + f.slice(1)).join(' · ')}</div>
                          </div>
                          <span className="sbx-caret"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={17} /></span>
                        </div>
                        {open && (
                          <div className="set-acct-settings">
                            {c.provider === 'google' && (
                              <>
                                {googleHasTasks && <ModuleBlock name="Google Tasks" on={mods.google !== false} onToggle={() => setMod('google', mods.google === false)} />}
                                <ColorRow label="Google Tasks color" k="google" cur={curColor} onPick={setColor} />
                                {(taskAccounts || []).filter((a) => a.connId === c.id).map((a) => (
                                  <div key={a.connId}><div className="cz-sec-title">Task lists</div>
                                    {(a.lists || []).map((l) => { const key = `${a.connId}::${l.id}`; return (
                                      <label key={l.id} className="cal-row"><input type="checkbox" checked={selectedTaskLists.includes(key)} onChange={() => toggleTaskList(key)} />{l.title}</label>
                                    ) })}
                                  </div>
                                ))}
                              </>
                            )}
                            {isZoho && (
                              <>
                                {crmError && <div className="set-warn">Zoho reported: {crmError}</div>}
                                <ModuleBlock name="CRM · Deals" on={mods.deals !== false} onToggle={() => setMod('deals', mods.deals === false)} opts={dealOpts} rules={filters.deals} onRules={(r) => setRules('deals', r)} emptyHint="No fields loaded yet — refresh, or reconnect Zoho so it can read your CRM fields." />
                                <ModuleBlock name="CRM · Leads" on={mods.leads !== false} onToggle={() => setMod('leads', mods.leads === false)} opts={leadOpts} rules={filters.leads} onRules={(r) => setRules('leads', r)} emptyHint="No fields loaded yet — refresh, or reconnect Zoho so it can read your CRM fields." />
                                <ColorRow label="Zoho CRM color" k="zoho-crm" cur={curColor} onPick={setColor} />
                                {projError && <div className="set-warn">Zoho reported: {projError}</div>}
                                <ModuleBlock name="Projects" on={mods.projects !== false} onToggle={() => setMod('projects', mods.projects === false)} opts={projOpts} rules={filters.projects} onRules={(r) => setRules('projects', r)}
                                  emptyHint="No filterable fields on your project tasks yet." extra={
                                    <div className="seg cz-seg" style={{ marginBottom: 12 }}>
                                      <button className={'seg-btn' + (navCfg.zohoAssignee !== 'all' ? ' on' : '')} onClick={() => onNavChange({ ...navCfg, zohoAssignee: 'mine' })}>Assigned to me</button>
                                      <button className={'seg-btn' + (navCfg.zohoAssignee === 'all' ? ' on' : '')} onClick={() => onNavChange({ ...navCfg, zohoAssignee: 'all' })}>All tasks</button>
                                    </div>
                                  } />
                                <ColorRow label="Zoho Projects color" k="zoho-projects" cur={curColor} onPick={setColor} />
                              </>
                            )}
                            <div className="set-acct-foot"><button className="link danger" onClick={() => onDisconnect(c.id)}>Disconnect account</button></div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>}
                <div className="set-group">
                  <div className="set-group-title">Add a connection</div>
                  {!addGoogle ? (
                    <div className="set-add-row">
                      <button className="btn add-conn" onClick={() => setAddGoogle(true)}><span className="conn-logo sm"><GoogleIcon size={20} /></span> Add Google</button>
                      <a className="btn add-conn" href="/api/zoho/start"><span className="conn-logo sm"><ZohoIcon size={20} /></span> Add Zoho</a>
                    </div>
                  ) : (
                    <div className="set-inline-add">
                      <div className="set-row-label" style={{ marginBottom: 8 }}>What should this Google account sync?</div>
                      <div className="conn-featrow">
                        <label className="chk"><input type="checkbox" checked={gfeats.calendar} onChange={(e) => setGfeats({ ...gfeats, calendar: e.target.checked })} /> Calendar</label>
                        <label className="chk"><input type="checkbox" checked={gfeats.tasks} onChange={(e) => setGfeats({ ...gfeats, tasks: e.target.checked })} /> Tasks</label>
                      </div>
                      <div className="modal-actions" style={{ marginTop: 12 }}><button className="btn" onClick={() => setAddGoogle(false)}>Cancel</button><div className="spacer" /><a className={'btn primary' + (!gfeats.calendar && !gfeats.tasks ? ' disabled' : '')} href={addHref} onClick={(e) => !gfeats.calendar && !gfeats.tasks && e.preventDefault()}>Connect Google</a></div>
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === 'calendar' && (
              <>
                <div className="set-group">
                  <div className="set-group-title">Density</div>
                  <div className="set-slider"><span className="lbl">Compact</span><input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /><span className="lbl">Roomy</span></div>
                </div>
                {(calAccounts || []).map((a) => (
                  <div key={a.connId} className="set-group">
                    <div className="set-group-title">Calendars · {a.email || 'Google'}</div>
                    {(a.calendars || []).map((cal) => { const key = `${a.connId}::${cal.id}`; return (
                      <label key={cal.id} className="cal-row"><input type="checkbox" checked={selectedCalendars.includes(key)} onChange={() => toggleCalendar(key)} /><span className="swatch" style={{ background: cal.color || '#888' }} />{cal.summary}</label>
                    ) })}
                    {!(a.calendars || []).length && <div className="muted" style={{ fontSize: 12 }}>No calendars found.</div>}
                  </div>
                ))}
                {!(calAccounts || []).length && <div className="muted">Connect a Google account with Calendar to choose which calendars show.</div>}
              </>
            )}

            {tab === 'focus' && (
              <>
                <div className="set-group">
                  <div className="set-group-title">Focus card</div>
                  <SettingRow label="Show the focus card by default" sub="The floating card that tells you what to work on now." on={!focusHidden} onClick={() => setFocusHidden(focusHidden ? false : true)} />
                  <button className="btn" style={{ marginTop: 10 }} onClick={() => { try { localStorage.removeItem('focus_card_box') } catch {} ; setFocusHidden(false) }}>Reset focus card position</button>
                </div>
                <div className="set-group">
                  <div className="set-group-title">Reminders</div>
                  {remState === 'granted'
                    ? <div className="muted">Reminders are on. You'll get a notification before each block starts.</div>
                    : <button className="btn primary" onClick={onEnableReminders} disabled={remState === 'unsupported'}>{remState === 'unsupported' ? 'Not supported in this browser' : 'Enable reminders'}</button>}
                </div>
              </>
            )}

            {tab === 'general' && (
              <>
              <div className="set-group">
                <div className="set-group-title">Appearance</div>
                <div className="seg cz-seg">
                  {['system', 'light', 'dark'].map((t) => (
                    <button key={t} className={'seg-btn' + (theme === t ? ' on' : '')} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                  ))}
                </div>
              </div>
              <div className="set-group">
                <div className="set-group-title">Time zone</div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>All times and the current-time line use this zone.</div>
                <select className="cz-select" value={tz} onChange={(e) => onChangeTz(e.target.value)}>
                  {tzList.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectModal({ project, onSave, onClose, onDelete }) {
  const [p, setP] = useState({ ...project })
  const save = () => { if (p.name.trim()) onSave({ ...p, name: p.name.trim() }) }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="modal-title">{p.isNew ? 'New project' : 'Edit project'}</div><button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button></div>
        <div><div className="field-label">Name</div><input className="field" autoFocus value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="e.g. Client work" /></div>
        <div><div className="field-label">Note (shows on the focus card)</div><input className="field" value={p.note || ''} onChange={(e) => setP({ ...p, note: e.target.value })} placeholder="Optional" /></div>
        <div><div className="field-label">Color</div><div className="swatches">{PALETTE.map((c) => <button key={c} className={'swatch-btn' + (p.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setP({ ...p, color: c })} />)}</div></div>
        <div className="modal-actions">
          {!p.isNew && <button className="link danger" onClick={() => { onDelete(p.id); onClose() }}>Delete</button>}
          <div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!p.name.trim()}>{p.isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ⌘K command palette — fuzzy-ish filter over app actions.
function CommandPalette({ actions, onClose }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = actions.filter((a) => a.label.toLowerCase().includes(q.trim().toLowerCase()))
  const clamped = Math.min(sel, Math.max(0, list.length - 1))
  const choose = (a) => { if (a) { a.run(); onClose() } }
  return (
    <div className="modal-backdrop cmd-backdrop" onClick={onClose}>
      <div className="cmd-modal" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(list[clamped]) }
        }}>
        <div className="cmd-search">
          <Icon name="search" size={17} />
          <input className="cmd-input" autoFocus placeholder="Type a command or search…" value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="cmd-list">
          {list.length === 0 && <div className="cmd-empty">No matching commands</div>}
          {list.map((a, i) => (
            <button key={a.id} className={'cmd-item' + (i === clamped ? ' on' : '')} onMouseEnter={() => setSel(i)} onClick={() => choose(a)}>
              <span className="cmd-item-ic"><Icon name={a.icon} size={16} /></span>
              <span className="cmd-item-label">{a.label}</span>
              {a.hint && <kbd className="kbd">{a.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ShortcutsModal({ onClose }) {
  const rows = [
    ['⌘K / Ctrl+K', 'Command palette'],
    ['T', 'Jump to today'],
    ['D / W / M', 'Day / Week / Month view'],
    ['← / →', 'Previous / next'],
    ['⌘Z / Ctrl+Z', 'Undo block change'],
    ['Double-click', 'Create a block'],
    ['?', 'Toggle this help'],
  ]
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="modal-head"><div className="modal-title">Keyboard shortcuts</div><button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button></div>
        <div className="shortcut-list">
          {rows.map(([k, d]) => (
            <div key={k} className="shortcut-row"><span className="shortcut-desc">{d}</span><kbd className="kbd">{k}</kbd></div>
          ))}
        </div>
      </div>
    </div>
  )
}

// A small iOS-style on/off switch.
function Switch({ on, onClick }) {
  return <button className={'switch' + (on ? ' on' : '')} onClick={onClick} aria-pressed={on}><span className="knob" /></button>
}

// Build field options for a module: prefer real field metadata (needs the Zoho
// settings scope); otherwise derive fields+values from the records themselves.
// Values merge the field's picklist with values present in the data.
function fieldOptsFrom(metaFields, tasks) {
  const t = tasks || []
  let meta = metaFields || []
  if (!meta.length) meta = [...new Set(t.flatMap((x) => Object.keys(x.fields || {})))].map((k) => ({ api_name: k, label: k, values: [] }))
  return meta.map((f) => {
    const present = t.map((x) => x.fields?.[f.api_name]).filter(Boolean)
    return { api_name: f.api_name, label: f.label, values: [...new Set([...(f.values || []), ...present])].sort() }
  }).filter((f) => f.values.length)
}

// Add-as-many-as-you-want filter builder for one module. rules = [{field, values}].
function FilterBuilder({ opts, rules, onChange, extra, emptyHint }) {
  const rs = rules || []
  const addRule = () => { const f = opts[0]; if (f) onChange([...rs, { field: f.api_name, values: [...f.values] }]) }
  const removeRule = (i) => onChange(rs.filter((_, j) => j !== i))
  const changeField = (i, api) => { const f = opts.find((o) => o.api_name === api); onChange(rs.map((r, j) => (j === i ? { field: api, values: [...(f?.values || [])] } : r))) }
  const toggleVal = (i, v) => onChange(rs.map((r, j) => (j === i ? { ...r, values: r.values.includes(v) ? r.values.filter((x) => x !== v) : [...r.values, v] } : r)))
  return (
    <>
      {extra}
      {rs.map((r, i) => {
        const opt = opts.find((o) => o.api_name === r.field)
        return (
          <div key={i} className="cz-rule">
            <div className="cz-rule-head">
              <select className="cz-select" value={r.field} onChange={(e) => changeField(i, e.target.value)}>
                {opts.map((o) => <option key={o.api_name} value={o.api_name}>{o.label}</option>)}
              </select>
              <button className="cz-rule-x" title="Remove filter" onClick={() => removeRule(i)}><Icon name="x" size={15} /></button>
            </div>
            <div className="cz-chips">{(opt?.values || []).map((v) => (
              <button key={v} className={'cz-chip' + (r.values.includes(v) ? ' on' : '')} onClick={() => toggleVal(i, v)}>{v}</button>
            ))}</div>
          </div>
        )
      })}
      {opts.length > 0
        ? <button className="cz-add" onClick={addRule}><Icon name="plus" size={14} /> Add filter</button>
        : <div className="muted" style={{ fontSize: 12 }}>{emptyHint || 'No fields available yet.'}</div>}
    </>
  )
}

function EventModal({ event, onClose }) {
  const e = event
  const rsvpText = { accepted: 'Going', declined: 'Declined', tentative: 'Maybe', needsAction: 'Awaiting' }
  const going = (e.attendees || []).filter((a) => a.status === 'accepted').length
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal event-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-head"><div className="modal-title">{e.title}</div><button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button></div>

        <div className="ev-meta">
          <span className="ev-meta-ic"><Icon name="clock" size={16} /></span>
          <span>{label(e.start)} – {label(e.end)}<span className="ev-dur"> · {fmtDur(e.end - e.start)}</span></span>
        </div>
        {e.location && (
          <div className="ev-meta">
            <span className="ev-meta-ic"><Icon name="mapPin" size={16} /></span>
            {/^https?:\/\//.test(e.location)
              ? <a href={e.location} target="_blank" rel="noreferrer" className="ev-link-text">{e.location}</a>
              : <span>{e.location}</span>}
          </div>
        )}
        {e.organizer && (
          <div className="ev-meta"><span className="ev-meta-ic"><Icon name="users" size={16} /></span><span>{e.organizer}{e.attendees?.length ? ` · ${e.attendees.length} guest${e.attendees.length > 1 ? 's' : ''}${going ? `, ${going} going` : ''}` : ''}</span></div>
        )}

        {e.link && (
          <a className="btn primary ev-join" href={e.link} target="_blank" rel="noreferrer"><Icon name="video" size={16} /> Join meeting</a>
        )}

        {e.description && (
          <div className="ev-desc-wrap">
            <div className="field-label"><Icon name="align" size={13} /> Details</div>
            <div className="ev-desc">{linkify(e.description)}</div>
          </div>
        )}

        {e.attendees?.length > 0 && (
          <div className="ev-guests">
            {e.attendees.slice(0, 8).map((a, i) => (
              <div key={i} className="ev-guest">
                <span className={'rsvp-dot ' + (a.status || 'needsAction')} />
                <span className="ev-guest-name">{a.name || a.email}{a.self ? ' (you)' : ''}</span>
                <span className="ev-guest-rsvp">{rsvpText[a.status] || ''}</span>
              </div>
            ))}
            {e.attendees.length > 8 && <div className="muted" style={{ padding: '2px 0' }}>+{e.attendees.length - 8} more</div>}
          </div>
        )}

        <div className="modal-actions">
          <div className="spacer" />
          {e.htmlLink && <a className="link" href={e.htmlLink} target="_blank" rel="noreferrer"><Icon name="externalLink" size={14} /> Open in Google Calendar</a>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function fmtDur(min) {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// Turn bare URLs in event descriptions into clickable links.
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g)
  return parts.map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noreferrer" className="ev-link-text">{p}</a>
      : <React.Fragment key={i}>{p}</React.Fragment>,
  )
}

function BlockModal({ entry, projects, onSave, onDelete, onDuplicate, onClose }) {
  const [b, setB] = useState({ ...entry.block })
  const isProject = !!b.projectId
  const proj = projects.find((p) => p.id === b.projectId)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="modal-title">Edit block</div><button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button></div>
        {isProject
          ? <div><div className="field-label">Project</div><div className="field" style={{ background: 'var(--panel-2)' }}>{proj?.name || 'Project'}</div></div>
          : <div><div className="field-label">Title</div><input className="field" value={b.title || ''} onChange={(e) => setB({ ...b, title: e.target.value })} /></div>}
        <div className="modal-row">
          <div style={{ flex: 1 }}><div className="field-label">Start</div><input type="time" className="field" step="900" value={minToTime(b.start)} onChange={(e) => { const s = timeToMin(e.target.value); setB((prev) => ({ ...prev, start: s, end: Math.max(prev.end, s + SNAP_MIN) })) }} /></div>
          <div style={{ flex: 1 }}><div className="field-label">End</div><input type="time" className="field" step="900" value={minToTime(b.end)} onChange={(e) => setB({ ...b, end: Math.max(timeToMin(e.target.value), b.start + SNAP_MIN) })} /></div>
        </div>
        {!isProject && <div><div className="field-label">Color</div><div className="swatches">{PALETTE.map((c) => <button key={c} className={'swatch-btn' + (b.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setB({ ...b, color: c })} />)}</div></div>}
        {Array.isArray(b.tasks) && b.tasks.length > 0 && <div className="muted">{b.tasks.length} task{b.tasks.length > 1 ? 's' : ''} in this block</div>}
        <div className="modal-actions"><button className="link danger" onClick={onDelete}>Delete</button>{onDuplicate && <button className="link" onClick={onDuplicate}>Duplicate</button>}<div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(b)}>Save</button></div>
      </div>
    </div>
  )
}
