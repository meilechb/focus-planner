import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  PALETTE, DAY_START, DAY_END, SNAP_MIN, ACCENT,
  isoDate, addDays, startOfWeek, weekDays, monthGridDays, monthOf, dayNum,
  label, labelShort, hourLabel, snap, clamp, uuid, buffersFrom, computeFocus, nowMinutes, localDateISO,
  fitDrop, clampMove, clampResizeBottom, clampResizeTop,
} from '../lib/lib.js'
import FocusCard from './FocusCard.jsx'
import { Icon } from './Icon.jsx'

const DEFAULT_TZ = 'America/New_York'
const ZOOM_KEY = 'focus_zoom'
const CACHE_KEY = 'focus_cache'
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} } }
const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const timeToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

export default function Planner() {
  const [tz, setTz] = useState(() => readCache().tz || DEFAULT_TZ)
  const [projects, setProjects] = useState(() => readCache().projects || [])
  const [blocks, setBlocks] = useState(() => readCache().blocks || {})
  const [favorites, setFavorites] = useState(() => readCache().favorites || [])
  const [connections, setConnections] = useState(() => readCache().connections || [])
  const [storageOk, setStorageOk] = useState(true)
  const [banner, setBanner] = useState('')

  const [calAccounts, setCalAccounts] = useState(() => readCache().calAccounts || [])
  const [taskAccounts, setTaskAccounts] = useState(() => readCache().taskAccounts || [])
  const [selectedCalendars, setSelectedCalendars] = useState(() => readCache().selectedCalendars || [])
  const [selectedTaskLists, setSelectedTaskLists] = useState(() => readCache().selectedTaskLists || [])
  const [eventsByDate, setEventsByDate] = useState(() => readCache().eventsByDate || {}) // { 'YYYY-MM-DD': [events] } — cached per day for instant paint
  const [gtasks, setGtasks] = useState(() => readCache().gtasks || [])
  const [zoho, setZoho] = useState(() => readCache().zoho || { crm: { deals: [], leads: [] }, projects: [], errors: [] })

  const [viewDate, setViewDate] = useState(() => isoDate(new Date(), readCache().tz || DEFAULT_TZ))
  const [view, setView] = useState(() => readCache().view || 'day') // day | week | month
  const [zoom, setZoom] = useState(() => Math.min(3, Math.max(1, Number(localStorage.getItem(ZOOM_KEY)) || 1.5)))
  const [now, setNow] = useState(() => nowMinutes(DEFAULT_TZ))

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
  const [showHelp, setShowHelp] = useState(false)

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
      const connP = api.get('/api/connections').catch(() => ({ connections: [] }))
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
      let conns = []
      try { conns = (await connP).connections || []; setConnections(conns) } catch {}
      if (conns.some((c) => c.provider === 'google')) await loadGoogleMeta(state)
      if (conns.some((c) => c.provider === 'zoho')) loadZoho()
      const p = new URLSearchParams(location.search)
      if (p.get('connected')) {
        const st = p.get('status')
        setBanner(st === 'ok' ? `${p.get('connected')} connected` : `Couldn't connect ${p.get('connected')} (${st})`)
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
      // Auto-select everything for any account that has NOTHING selected yet
      // (a newly connected account), without clobbering per-account choices.
      const baseCals = state?.selectedCalendars || []
      const nextCals = [...baseCals]
      for (const a of cal.accounts || []) {
        const keys = a.calendars.map((c) => `${a.connId}::${c.id}`)
        if (keys.length && !keys.some((k) => nextCals.includes(k))) nextCals.push(...keys)
      }
      if (nextCals.length !== baseCals.length) { setSelectedCalendars(nextCals); saveKey('selectedCalendars', nextCals) }

      const baseLists = state?.selectedTaskLists || []
      const nextLists = [...baseLists]
      for (const a of tl.accounts || []) {
        const keys = a.lists.map((l) => `${a.connId}::${l.id}`)
        if (keys.length && !keys.some((k) => nextLists.includes(k))) nextLists.push(...keys)
      }
      if (nextLists.length !== baseLists.length) { setSelectedTaskLists(nextLists); saveKey('selectedTaskLists', nextLists) }
    } catch (e) { console.error('google meta', e) }
  }
  async function loadZoho() {
    try { setZoho(await api.post('/api/zoho/data', { action: 'fetch' })) } catch (e) { console.error('zoho', e) }
  }
  async function disconnect(id) {
    await api.del('/api/connections?id=' + id).catch(() => {})
    setConnections((await api.get('/api/connections').catch(() => ({ connections: [] }))).connections || [])
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
  }, [connected, selectedCalendars, today, range.start, range.end])

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (e.target.closest && e.target.closest('input, textarea')) return
        e.preventDefault(); undoBlocks(); return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target.closest && e.target.closest('input, textarea, .modal')) return
      const k = e.key.toLowerCase()
      const stepFor = () => (view === 'week' ? 7 : view === 'month' ? 30 : 1)
      if (k === 't') setViewDate(today)
      else if (k === 'd') setView('day')
      else if (k === 'w') setView('week')
      else if (k === 'm') setView('month')
      else if (k === '?' || (e.key === '/' && e.shiftKey)) setShowHelp((v) => !v)
      else if (e.key === 'Escape') setShowHelp(false)
      else if (e.key === 'ArrowLeft') setViewDate((v) => addDays(v, -stepFor()))
      else if (e.key === 'ArrowRight') setViewDate((v) => addDays(v, stepFor()))
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
      setEditBlock(null); setEditProject(null); setShowConn(false); setShowHelp(false)
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
  function undoBlocks() { const prev = undoStack.current.pop(); if (prev) { setBlocks(prev); saveKey('blocks', prev) } }
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
    const dueOk = (t) => taskFilter === 'all' || (t.due && localDateISO(t.due, tz) === viewDate)
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
    if (hasZoho) {
      const crmLists = []
      if (zoho.crm.deals.length) crmLists.push({ id: 'deals', title: 'Deals', tasks: zoho.crm.deals.map((d) => ({ id: d.id, title: d.title, sub: d.sub, status: 'needsAction', source: 'zoho' })).filter(searchOk) })
      if (zoho.crm.leads.length) crmLists.push({ id: 'leads', title: 'Leads', tasks: zoho.crm.leads.map((d) => ({ id: d.id, title: d.title, sub: d.sub, status: 'needsAction', source: 'zoho' })).filter(searchOk) })
      if (crmLists.length) groups.push({ id: 'zoho-crm', account: 'Zoho CRM', lists: crmLists })
      if (zoho.projects.length) groups.push({ id: 'zoho-projects', account: 'Zoho Projects', lists: zoho.projects.map((p) => ({ id: p.id, title: p.name, tasks: p.tasks.map((t) => ({ ...t, source: 'zoho' })).filter(searchOk) })) })
    }
    return groups
  }, [connected, hasZoho, taskAccounts, gtasks, zoho, taskFilter, taskSearch, tz, viewDate])

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
    if (payload.kind === 'task') return { id: uuid(), start, end, tasks: [payload.task] }
    if (payload.kind === 'batch') return { id: uuid(), start, end, title: payload.title, color: '#2563eb', tasks: payload.tasks }
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
      <Sidebar
        projects={projects} onNewProject={newProject} onEditProject={setEditProject} onDeleteProject={deleteProject}
        favorites={favorites} isFav={isFav} toggleFav={toggleFav}
        connected={connected} hasZoho={hasZoho} groups={displayGroups}
        taskFilter={taskFilter} setTaskFilter={setTaskFilter} taskSearch={taskSearch} setTaskSearch={setTaskSearch}
        collapsed={collapsed} setCollapsed={setCollapsed} sections={sections} setSections={setSections}
        connections={connections} onOpenConnections={() => setShowConn(true)}
        remState={remState} onEnableReminders={enableReminders}
        tz={tz} today={today}
      />

      <main className="main">
        <TopBar
          view={view} setView={setView} viewDate={viewDate} setViewDate={setViewDate} today={today}
          zoom={zoom} setZoom={setZoom} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)}
          planned={(dayBlocks(viewDate)).reduce((n, b) => n + (b.end - b.start), 0)}
        />
        {!storageOk && <div className="banner warn">Couldn't reach storage — retrying to save your changes…</div>}
        {banner && <div className="banner ok">{banner}<button className="icon-btn x" onClick={() => setBanner('')}><Icon name="x" size={16} /></button></div>}

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
          />
        )}
        {view === 'month' && (
          <MonthGrid
            viewDate={viewDate} today={today} blocksByDay={blocks} meetingsFor={meetingsFor}
            blockColor={blockColor} blockName={blockName}
            onOpenDay={(d) => { setViewDate(d); setView('day') }}
          />
        )}
        </div>
      </main>

      {!focusHidden && (
        <FocusCard focus={focus} now={now}
          onToggleTask={(t) => applyTaskCompletion(t, t.status !== 'completed')}
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
        <ConnectionsModal connections={connections} onDisconnect={disconnect}
          calAccounts={calAccounts} selectedCalendars={selectedCalendars} toggleCalendar={toggleCalendar}
          onClose={() => setShowConn(false)} />
      )}
      {showHelp && <ShortcutsModal onClose={() => setShowHelp(false)} />}
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
  const gotoMonth = (n) => { const nd = new Date(d); nd.setMonth(nd.getMonth() + n); setViewDate(nd.toISOString().slice(0, 10)) }
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
function DayGrid({ day, today, now, zoom, blocks, meetings, blockColor, blockName, onCommit, onEdit, onDelete, onCreateAt, onDropPayload }) {
  const ref = useRef(null)
  const scrollRef = useRef(null)
  const drag = useRef(null)
  const latest = useRef(blocks)
  const [localBlocks, setLocalBlocks] = useState(blocks)
  const [hint, setHint] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  useEffect(() => { latest.current = blocks; setLocalBlocks(blocks) }, [blocks])
  // scroll current time into view on first open of today
  useEffect(() => {
    if (scrollRef.current && day === today) scrollRef.current.scrollTop = Math.max(0, (now - DAY_START) * zoom - 150)
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
        onDragOver={(e) => { e.preventDefault(); const s = fitDrop(occAll(), yToMin(e.clientY), 60); setHint(s || { start: yToMin(e.clientY), end: yToMin(e.clientY) + SNAP_MIN, none: true }) }}
        onDragLeave={(e) => { if (e.target === ref.current) setHint(null) }}
        onDrop={(e) => { e.preventDefault(); const s = fitDrop(occAll(), yToMin(e.clientY), 60); setHint(null); if (s) { try { onDropPayload(JSON.parse(e.dataTransfer.getData('application/json')), s.start, s.end) } catch {} } }}>
        {hours.map((h) => (
          <div key={h} className="hour-row" style={{ top: (h - DAY_START) * zoom }}><span className="hour-label">{hourLabel(h)}</span></div>
        ))}
        {hint && <div className={'drop-hint' + (hint.none ? ' invalid' : '')} style={{ top: (hint.start - DAY_START) * zoom, height: (hint.end - hint.start) * zoom }}>{hint.none ? 'No room' : `${label(hint.start)} – ${label(hint.end)}`}</div>}
        {buffers.map((b, i) => <div key={'b' + i} className="ev ev-buffer" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 8, right: 10 }}>Prep · {b.forTitle}</div>)}
        {meetings.map((m) => { const mh = (m.end - m.start) * zoom; return (
          <div key={m.id} className="ev ev-meeting" style={{ top: (m.start - DAY_START) * zoom, height: mh, left: 8, right: 10 }} title={m.title}>
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
function WeekGrid({ viewDate, today, now, zoom, projects, blocksByDay, meetingsFor, blockColor, blockName, onOpenDay, onEdit, onCreateAt, onDropPayload }) {
  const days = weekDays(viewDate)
  const height = (DAY_END - DAY_START) * zoom
  const hours = []; for (let h = DAY_START; h <= DAY_END; h += 60) hours.push(h)
  const colRefs = useRef({})
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current && days.includes(today)) scrollRef.current.scrollTop = Math.max(0, (now - DAY_START) * zoom - 150)
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
                {meetings.map((m) => <div key={m.id} className="ev ev-meeting" style={{ top: (m.start - DAY_START) * zoom, height: (m.end - m.start) * zoom, left: 2, right: 2 }} title={`${m.title} · ${label(m.start)}`}><div className="ev-title">{m.title}</div>{(m.end - m.start) * zoom > 28 && <div className="ev-time">{label(m.start)}</div>}</div>)}
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
    taskFilter, setTaskFilter, taskSearch, setTaskSearch, collapsed, setCollapsed, sections, setSections,
    connections, onOpenConnections, remState, onEnableReminders, tz, today,
  } = props
  function dueBadge(due) {
    if (!due) return null
    const iso = localDateISO(due, tz)
    if (!iso) return null
    const overdue = iso < today
    const isToday = iso === today
    if (!overdue && !isToday && iso > today) {
      const d = new Date(iso + 'T12:00:00')
      const soon = (new Date(d) - new Date(today + 'T12:00:00')) / 86400000 <= 7
      if (!soon) return null
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
  const dragTask = (e, task, g, l) => { e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'task', task: { ...task, connId: g.id, listId: l.id } })); chip(e, task.title, g.id.startsWith('zoho') ? '#e42527' : '#2563eb') }
  const dragBatch = (e, g, l) => { const tasks = l.tasks.filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: g.id, listId: l.id })); e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'batch', title: l.title, tasks })); chip(e, `${l.title} · ${tasks.length}`, g.id.startsWith('zoho') ? '#e42527' : '#2563eb') }
  const dragFav = (e, f) => { e.dataTransfer.setData('application/json', JSON.stringify(f.payload)); chip(e, f.label, f.color) }
  const toggleSec = (k) => setSections({ ...sections, [k]: !sections[k] })

  const projEntry = (p) => ({ id: 'p:' + p.id, kind: 'project', label: p.name, color: p.color, projectId: p.id, payload: { kind: 'project', projectId: p.id } })
  const taskEntry = (t, g, l) => ({ id: `t:${g.id}:${l.id}:${t.id}`, kind: 'task', label: t.title, color: g.id.startsWith('zoho') ? '#e42527' : '#2563eb', payload: { kind: 'task', task: { ...t, connId: g.id, listId: l.id } } })
  const zpEntry = (g, l) => ({ id: 'z:' + l.id, kind: 'zohoproject', label: l.title, color: '#e42527', payload: { kind: 'batch', title: l.title, tasks: l.tasks.filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: g.id, listId: l.id })) } })
  const favIcon = (k) => (k === 'project' ? 'folder' : k === 'zohoproject' ? 'list' : 'check')
  const taskCount = groups.reduce((a, g) => a + g.lists.reduce((b, l) => b + l.tasks.length, 0), 0)

  return (
    <aside className="sidebar">
      <div className="brand"><span className="dot" /> Focus Planner</div>

      <div className="sb-scroll">
        {favorites.length > 0 && (
          <div className="sb-block">
            <div className="sb-head"><span><span className="sb-ic"><Icon name="star" size={13} filled /></span> Favorites</span></div>
            <div className="fav-grid">
              {favorites.map((f) => (
                <div key={f.id} className="fav-card" style={{ background: f.color }} draggable onDragStart={(e) => dragFav(e, f)}
                  onClick={() => { if (f.kind === 'project') { const p = projects.find((x) => x.id === f.projectId); if (p) onEditProject(p) } }}>
                  <span className="fav-ic"><Icon name={favIcon(f.kind)} size={13} /></span>
                  <span className="fav-name">{f.label}</span>
                  <button className="fav-x" title="Unfavorite" onClick={(e) => { e.stopPropagation(); toggleFav(f) }}><Icon name="star" size={12} filled /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="sb-block">
          <div className="sb-head clickable" onClick={() => toggleSec('projects')}>
            <span><span className="sb-ic"><Icon name="folder" size={13} /></span> Projects{projects.length > 0 && <span className="sec-count">{projects.length}</span>}</span><span className="caret"><Icon name={sections.projects ? 'chevronRight' : 'chevronDown'} size={16} /></span>
          </div>
          {!sections.projects && (
            <>
              <div className="proj-list">
                {projects.map((p) => (
                  <div key={p.id} className="proj-row" draggable onDragStart={(e) => dragProject(e, p)}>
                    <span className="swatch" style={{ background: p.color }} />
                    <span className="proj-name" onClick={() => onEditProject(p)}>{p.name}</span>
                    <button className={'star' + (isFav('p:' + p.id) ? ' on' : '')} title="Favorite" onClick={() => toggleFav(projEntry(p))}><Icon name="star" size={14} filled={isFav('p:' + p.id)} /></button>
                    <button className="row-x" onClick={() => onDeleteProject(p.id)}><Icon name="x" size={14} /></button>
                  </div>
                ))}
                {projects.length === 0 && <div className="muted" style={{ padding: '2px 8px' }}>No projects yet — add one and drag it onto the grid.</div>}
              </div>
              <button className="btn new-proj" onClick={onNewProject}><Icon name="plus" size={15} /> New project</button>
            </>
          )}
        </div>

        <div className="sb-block">
          <div className="sb-head"><span><span className="sb-ic"><Icon name="check" size={13} /></span> Tasks{taskCount > 0 && <span className="sec-count">{taskCount}</span>}</span>
            <div className="seg">
              <button className={'seg-btn' + (taskFilter === 'all' ? ' on' : '')} onClick={() => setTaskFilter('all')}>All</button>
              <button className={'seg-btn' + (taskFilter === 'today' ? ' on' : '')} onClick={() => setTaskFilter('today')}>Today</button>
            </div>
          </div>
          <div className="task-search"><Icon name="search" size={15} className="search-ic" /><input className="field" placeholder="Search tasks…" value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} /></div>
          {!connected && !hasZoho && (
            <div className="empty-hint">No accounts connected.<br /><button className="link" onClick={onOpenConnections}>Connect Google or Zoho</button> to see your tasks.</div>
          )}
          {groups.map((g) => (
            <div key={g.id} className="tgroup">
              <div className="tgroup-head"><span className="acct-dot" style={{ background: g.id.startsWith('zoho') ? '#e42527' : '#2563eb' }} />{g.account}</div>
              {g.lists.map((l) => {
                const key = g.id + '/' + l.id; const col = collapsed[key]
                const isZP = g.id === 'zoho-projects'
                return (
                  <div key={l.id}>
                    <div className="tlist-head" draggable onDragStart={(e) => dragBatch(e, g, l)}>
                      <button className="caret" onClick={() => setCollapsed({ ...collapsed, [key]: !col })}><Icon name={col ? 'chevronRight' : 'chevronDown'} size={15} /></button>
                      <span className="tlist-title">{l.title}</span>
                      {isZP && <button className={'star' + (isFav('z:' + l.id) ? ' on' : '')} title="Favorite project" onClick={(e) => { e.stopPropagation(); toggleFav(zpEntry(g, l)) }}><Icon name="star" size={14} filled={isFav('z:' + l.id)} /></button>}
                      <span className="tlist-count">{l.tasks.length}</span>
                    </div>
                    {!col && l.tasks.map((t) => {
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
                  </div>
                )
              })}
            </div>
          ))}
          {(connected || hasZoho) && groups.every((g) => g.lists.every((l) => !l.tasks.length)) && (
            <div className="muted" style={{ padding: '8px' }}>No open tasks{taskSearch ? ' match your search' : ''}.</div>
          )}
        </div>
      </div>

      <div className="sidebar-foot">
        <button className="btn conn-btn" onClick={onOpenConnections}>
          <span className="gear"><Icon name="settings" size={15} /></span> Connections{connections.length ? <span className="conn-count">{connections.length}</span> : ''}
        </button>
        {remState !== 'granted' && <button className="link" style={{ marginTop: 8 }} onClick={onEnableReminders} disabled={remState === 'unsupported'}>Enable reminders</button>}
      </div>
    </aside>
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

function ConnectionsModal({ connections, onDisconnect, calAccounts, selectedCalendars, toggleCalendar, onClose }) {
  const [detail, setDetail] = useState(null)
  const [addGoogle, setAddGoogle] = useState(false)
  const featBadges = (c) => (c.provider === 'google' ? (c.extra?.features || ['calendar', 'tasks']) : ['deals', 'leads', 'projects'])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal conn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conn-modal-head">
          <div className="modal-title">Connections</div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="conn-body">
          {connections.length > 0 && <>
            <div className="conn-section-label">Your connections</div>
            <div className="conn-grid">
              {connections.map((c) => (
                <button key={c.id} className="conn-card2" onClick={() => setDetail(c)}>
                  <div className="conn-logo"><ProviderIcon provider={c.provider} /></div>
                  <div className="conn-card2-body">
                    <div className="conn-card2-title">{c.account_label || c.provider}</div>
                    <div className="conn-card2-sub">{featBadges(c).join(' · ')}</div>
                  </div>
                  <span className="conn-chev"><Icon name="chevronRight" size={18} /></span>
                </button>
              ))}
            </div>
          </>}

          <div className="conn-section-label">Add a connection</div>
          <div className="conn-grid">
            <button className="conn-card2" onClick={() => setAddGoogle(true)}>
              <div className="conn-logo"><GoogleIcon /></div>
              <div className="conn-card2-body"><div className="conn-card2-title">Google</div><div className="conn-card2-sub">Calendar & Tasks</div></div>
              <span className="conn-chev"><Icon name="plus" size={18} /></span>
            </button>
            <a className="conn-card2" href="/api/zoho/start">
              <div className="conn-logo"><ZohoIcon /></div>
              <div className="conn-card2-body"><div className="conn-card2-title">Zoho</div><div className="conn-card2-sub">Deals, leads & projects</div></div>
              <span className="conn-chev"><Icon name="plus" size={18} /></span>
            </a>
          </div>
        </div>
      </div>

      {detail && (
        <ConnectionDetailModal connection={detail}
          calendars={detail.provider === 'google' && (detail.extra?.features || ['calendar']).includes('calendar') ? (calAccounts.find((a) => a.connId === detail.id)?.calendars || []) : []}
          selectedCalendars={selectedCalendars} toggleCalendar={toggleCalendar}
          onDisconnect={() => { onDisconnect(detail.id); setDetail(null) }} onClose={() => setDetail(null)} />
      )}
      {addGoogle && <AddGoogleModal onClose={() => setAddGoogle(false)} />}
    </div>
  )
}

function ConnectionDetailModal({ connection: c, calendars, selectedCalendars, toggleCalendar, onDisconnect, onClose }) {
  const feats = c.provider === 'google' ? (c.extra?.features || ['calendar', 'tasks']) : ['deals', 'leads', 'projects']
  return (
    <div className="modal-backdrop nested" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="conn-detail-head">
          <div className="conn-logo lg"><ProviderIcon provider={c.provider} size={32} /></div>
          <div><div className="modal-title">{c.account_label || c.provider}</div><div className="muted" style={{ textTransform: 'capitalize' }}>{c.provider}</div></div>
        </div>
        <div><div className="field-label">Syncing</div><div className="conn-card-badges">{feats.map((f) => <span key={f} className="conn-badge">{f}</span>)}</div></div>
        {calendars.length > 0 && (
          <div><div className="field-label">Calendars shown on the grid</div>
            {calendars.map((cal) => { const key = `${c.id}::${cal.id}`; return (
              <label key={cal.id} className="cal-row"><input type="checkbox" checked={selectedCalendars.includes(key)} onChange={() => toggleCalendar(key)} /><span className="swatch" style={{ background: cal.color || '#888' }} />{cal.summary}</label>
            ) })}
          </div>
        )}
        <div className="modal-actions"><button className="link danger" onClick={onDisconnect}>Disconnect account</button><div className="spacer" /><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function AddGoogleModal({ onClose }) {
  const [feats, setFeats] = useState({ calendar: true, tasks: true })
  const href = `/api/google/start?feats=${[feats.calendar && 'calendar', feats.tasks && 'tasks'].filter(Boolean).join(',') || 'tasks'}`
  const none = !feats.calendar && !feats.tasks
  return (
    <div className="modal-backdrop nested" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="conn-detail-head"><div className="conn-logo lg"><GoogleIcon size={32} /></div><div className="modal-title">Add a Google account</div></div>
        <div className="muted">Choose what to sync from this account. You can add as many Google accounts as you like.</div>
        <div className="conn-featrow">
          <label className="chk"><input type="checkbox" checked={feats.calendar} onChange={(e) => setFeats({ ...feats, calendar: e.target.checked })} /> Calendar</label>
          <label className="chk"><input type="checkbox" checked={feats.tasks} onChange={(e) => setFeats({ ...feats, tasks: e.target.checked })} /> Tasks</label>
        </div>
        <div className="modal-actions"><div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><a className={'btn primary' + (none ? ' disabled' : '')} href={href} onClick={(e) => none && e.preventDefault()}>Connect Google</a></div>
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

function ShortcutsModal({ onClose }) {
  const rows = [
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
          <div style={{ flex: 1 }}><div className="field-label">Start</div><input type="time" className="field" step="900" value={minToTime(b.start)} onChange={(e) => setB({ ...b, start: timeToMin(e.target.value) })} /></div>
          <div style={{ flex: 1 }}><div className="field-label">End</div><input type="time" className="field" step="900" value={minToTime(b.end)} onChange={(e) => setB({ ...b, end: Math.max(timeToMin(e.target.value), b.start + SNAP_MIN) })} /></div>
        </div>
        {!isProject && <div><div className="field-label">Color</div><div className="swatches">{PALETTE.map((c) => <button key={c} className={'swatch-btn' + (b.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setB({ ...b, color: c })} />)}</div></div>}
        {Array.isArray(b.tasks) && b.tasks.length > 0 && <div className="muted">{b.tasks.length} task{b.tasks.length > 1 ? 's' : ''} in this block</div>}
        <div className="modal-actions"><button className="link danger" onClick={onDelete}>Delete</button>{onDuplicate && <button className="link" onClick={onDuplicate}>Duplicate</button>}<div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(b)}>Save</button></div>
      </div>
    </div>
  )
}
