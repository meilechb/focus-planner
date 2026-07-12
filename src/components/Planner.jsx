import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { MOCK_MEETINGS, MOCK_TASK_GROUPS } from '../lib/mock.js'
import {
  PALETTE, DAY_START, DAY_END, SNAP_MIN, ACCENT,
  isoDate, addDays, startOfWeek, weekDays, monthGridDays, monthOf, dayNum,
  label, labelShort, snap, clamp, uuid, buffersFrom, computeFocus, nowMinutes, localDateISO,
} from '../lib/lib.js'
import FocusCard from './FocusCard.jsx'

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
  const [connections, setConnections] = useState([])
  const [storageOk, setStorageOk] = useState(true)
  const [banner, setBanner] = useState('')

  const [calAccounts, setCalAccounts] = useState([])
  const [taskAccounts, setTaskAccounts] = useState([])
  const [selectedCalendars, setSelectedCalendars] = useState(() => readCache().selectedCalendars || [])
  const [selectedTaskLists, setSelectedTaskLists] = useState(() => readCache().selectedTaskLists || [])
  const [rangeEvents, setRangeEvents] = useState([]) // events across the visible range, each with .date
  const [todayEvents, setTodayEvents] = useState([]) // events for today (drives the focus card)
  const [gtasks, setGtasks] = useState([])
  const [zoho, setZoho] = useState({ crm: { deals: [], leads: [] }, projects: [], errors: [] })

  const [viewDate, setViewDate] = useState(() => isoDate(new Date(), readCache().tz || DEFAULT_TZ))
  const [view, setView] = useState('day') // day | week | month
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem(ZOOM_KEY)) || 1.3)
  const [now, setNow] = useState(() => nowMinutes(DEFAULT_TZ))

  const [taskFilter, setTaskFilter] = useState('all')
  const [taskSearch, setTaskSearch] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [sections, setSections] = useState({ projects: false, tasks: false })
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [focusHidden, setFocusHidden] = useState(false)
  const [overrideBlockId, setOverrideBlockId] = useState(null)
  const [editProject, setEditProject] = useState(null)
  const [editBlock, setEditBlock] = useState(null) // { block, day }
  const [showConn, setShowConn] = useState(false)

  const today = isoDate(new Date(), tz)
  const connected = connections.some((c) => c.provider === 'google')
  const hasZoho = connections.some((c) => c.provider === 'zoho')

  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)) }, [zoom])
  // instant paint on next load
  useEffect(() => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ tz, projects, blocks, selectedCalendars, selectedTaskLists }))
  }, [tz, projects, blocks, selectedCalendars, selectedTaskLists])

  // --- boot -----------------------------------------------------------------
  useEffect(() => {
    ;(async () => {
      let state = null
      try {
        const r = await api.get('/api/data')
        state = r.state
        if (state.timezone) setTz(state.timezone)
        setProjects(state.projects || [])
        setBlocks(state.blocks || {})
        setSelectedCalendars(state.selectedCalendars || [])
        setSelectedTaskLists(state.selectedTaskLists || [])
        setStorageOk(true)
      } catch { setStorageOk(false) }
      let conns = []
      try { conns = (await api.get('/api/connections')).connections || []; setConnections(conns) } catch {}
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

  useEffect(() => {
    if (!connected || !selectedCalendars.length) { setRangeEvents([]); return }
    let alive = true
    api.post('/api/google/data', { action: 'eventsRange', startISO: range.start, endISO: range.end, cals: calsPayload() })
      .then((r) => alive && setRangeEvents(r.events || [])).catch(() => alive && setRangeEvents([]))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedCalendars, range.start, range.end])

  useEffect(() => {
    if (!connected || !selectedCalendars.length) { setTodayEvents([]); return }
    let alive = true
    api.post('/api/google/data', { action: 'eventsRange', startISO: today, endISO: today, cals: calsPayload() })
      .then((r) => alive && setTodayEvents(r.events || [])).catch(() => alive && setTodayEvents([]))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, selectedCalendars, today])

  useEffect(() => {
    if (!connected || !selectedTaskLists.length) { setGtasks([]); return }
    const lists = selectedTaskLists.map((k) => { const [connId, listId] = k.split('::'); return { connId, listId } })
    let alive = true
    api.post('/api/google/data', { action: 'tasks', lists })
      .then((r) => alive && setGtasks(r.tasks || [])).catch(() => alive && setGtasks([]))
    return () => { alive = false }
  }, [connected, selectedTaskLists])

  useEffect(() => { const id = setInterval(() => setNow(nowMinutes(tz)), 30000); setNow(nowMinutes(tz)); return () => clearInterval(id) }, [tz])

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
  function saveKey(key, value) { if (!storageOk) return; pending.current.set(key, value); clearTimeout(timer.current); timer.current = setTimeout(flush, 400) }
  async function flush() {
    if (flushing.current) return; flushing.current = true
    try {
      while (pending.current.size) {
        const [key, value] = pending.current.entries().next().value
        pending.current.delete(key)
        try { await api.post('/api/data', { key, value }) } catch { setStorageOk(false) }
      }
    } finally { flushing.current = false }
  }

  function updateProjects(n) { setProjects(n); saveKey('projects', n) }
  function updateBlocks(n) { setBlocks(n); saveKey('blocks', n) }
  const dayBlocks = (d) => blocks[d] || []
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
  function deleteProject(id) { updateProjects(projects.filter((x) => x.id !== id)) }

  function toggleCalendar(k) { const n = selectedCalendars.includes(k) ? selectedCalendars.filter((x) => x !== k) : [...selectedCalendars, k]; setSelectedCalendars(n); saveKey('selectedCalendars', n) }
  function toggleTaskList(k) { const n = selectedTaskLists.includes(k) ? selectedTaskLists.filter((x) => x !== k) : [...selectedTaskLists, k]; setSelectedTaskLists(n); saveKey('selectedTaskLists', n) }

  const meetingsFor = (d) => (connected ? rangeEvents.filter((e) => e.date === d) : (d === today ? MOCK_MEETINGS : []))

  // --- task groups ----------------------------------------------------------
  const displayGroups = useMemo(() => {
    const q = taskSearch.trim().toLowerCase()
    const dueOk = (t) => taskFilter === 'all' || (t.due && localDateISO(t.due, tz) === viewDate)
    const searchOk = (t) => !q || (t.title || '').toLowerCase().includes(q) || (t.sub || '').toLowerCase().includes(q)
    const groups = []
    if (!connected && !hasZoho) {
      for (const g of MOCK_TASK_GROUPS) groups.push({ ...g, lists: g.lists.map((l) => ({ ...l, tasks: l.tasks.filter(dueOk).filter(searchOk) })) })
    }
    if (connected) {
      for (const a of taskAccounts) groups.push({
        id: a.connId, account: a.email || 'Google',
        lists: a.lists.map((l) => ({ id: l.id, title: l.title, tasks: gtasks.filter((t) => t.connId === a.connId && t.listId === l.id).filter(dueOk).filter(searchOk).map((t) => ({ ...t, source: 'google' })) })),
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
    const m = connected ? todayEvents : (MOCK_MEETINGS)
    return computeFocus({ blocks: todays, meetings: m, buffers: buffersFrom(m), now, projects })
  }, [blocks, today, overrideBlockId, connected, todayEvents, now, projects])

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

  // --- create a block from a drop payload ----------------------------------
  function blockFromPayload(payload, start) {
    if (payload.kind === 'project') return { id: uuid(), start, end: Math.min(start + 60, DAY_END), projectId: payload.projectId }
    if (payload.kind === 'task') return { id: uuid(), start, end: Math.min(start + 30, DAY_END), tasks: [payload.task] }
    if (payload.kind === 'batch') { const dur = clamp(payload.tasks.length * 30, 30, 240); return { id: uuid(), start, end: Math.min(start + dur, DAY_END), title: payload.title, color: '#2563eb', tasks: payload.tasks } }
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
        connected={connected} hasZoho={hasZoho} groups={displayGroups}
        taskFilter={taskFilter} setTaskFilter={setTaskFilter} taskSearch={taskSearch} setTaskSearch={setTaskSearch}
        collapsed={collapsed} setCollapsed={setCollapsed} sections={sections} setSections={setSections}
        connections={connections} onOpenConnections={() => setShowConn(true)}
        remState={remState} onEnableReminders={enableReminders}
      />

      <main className="main">
        <TopBar
          view={view} setView={setView} viewDate={viewDate} setViewDate={setViewDate} today={today}
          zoom={zoom} setZoom={setZoom} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        {!storageOk && <div className="banner warn">Storage not reachable — changes are in-memory only.</div>}
        {banner && <div className="banner ok">{banner}<button className="icon-btn x" onClick={() => setBanner('')}>×</button></div>}

        {view === 'day' && (
          <DayGrid
            day={viewDate} today={today} now={now} zoom={zoom}
            blocks={dayBlocks(viewDate)} meetings={meetingsFor(viewDate)} projects={projects}
            blockColor={blockColor} blockName={blockName}
            onCommit={(list) => setDayBlocks(viewDate, list)}
            onEdit={(b) => setEditBlock({ block: b, day: viewDate })}
            onDelete={(id) => deleteBlock(viewDate, id)}
            onCreateAt={(min) => { const b = { id: uuid(), start: min, end: Math.min(min + 30, DAY_END), title: 'Focus', color: ACCENT, tasks: [] }; addBlockTo(viewDate, b); setEditBlock({ block: b, day: viewDate }) }}
            onDropPayload={(payload, min) => { const b = blockFromPayload(payload, min); if (b) addBlockTo(viewDate, b) }}
          />
        )}
        {view === 'week' && (
          <WeekGrid
            viewDate={viewDate} today={today} now={now} zoom={zoom} projects={projects}
            blocksByDay={blocks} meetingsFor={meetingsFor} blockColor={blockColor} blockName={blockName}
            onOpenDay={(d) => { setViewDate(d); setView('day') }}
            onEdit={(b, d) => setEditBlock({ block: b, day: d })}
            onCreateAt={(d, min) => { const b = { id: uuid(), start: min, end: Math.min(min + 30, DAY_END), title: 'Focus', color: ACCENT, tasks: [] }; addBlockTo(d, b); setEditBlock({ block: b, day: d }) }}
            onDropPayload={(d, payload, min) => { const b = blockFromPayload(payload, min); if (b) addBlockTo(d, b) }}
          />
        )}
        {view === 'month' && (
          <MonthGrid
            viewDate={viewDate} today={today} blocksByDay={blocks} meetingsFor={meetingsFor}
            blockColor={blockColor} blockName={blockName}
            onOpenDay={(d) => { setViewDate(d); setView('day') }}
          />
        )}
      </main>

      {!focusHidden && (
        <FocusCard focus={focus} now={now}
          onToggleTask={(t) => applyTaskCompletion(t, t.status !== 'completed')}
          onNext={advanceToNext} onHide={() => setFocusHidden(true)} />
      )}
      {focusHidden && <button className="focus-show" onClick={() => setFocusHidden(false)}>Focus</button>}

      {editProject && <ProjectModal project={editProject} onSave={saveProject} onClose={() => setEditProject(null)} onDelete={deleteProject} />}
      {editBlock && (
        <BlockModal entry={editBlock} projects={projects}
          onSave={(b) => { updateBlock(editBlock.day, b); setEditBlock(null) }}
          onDelete={() => { deleteBlock(editBlock.day, editBlock.block.id); setEditBlock(null) }}
          onClose={() => setEditBlock(null)} />
      )}
      {showConn && (
        <ConnectionsModal connections={connections} onDisconnect={disconnect}
          calAccounts={calAccounts} selectedCalendars={selectedCalendars} toggleCalendar={toggleCalendar}
          onClose={() => setShowConn(false)} />
      )}
    </div>
  )
}

/* ========================================================================== */

function TopBar({ view, setView, viewDate, setViewDate, today, zoom, setZoom, sidebarOpen, onToggleSidebar }) {
  const step = view === 'week' ? 7 : view === 'month' ? 30 : 1
  const d = new Date(viewDate + 'T12:00:00')
  let title
  if (view === 'month') title = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  else if (view === 'week') { const w = weekDays(viewDate); const a = new Date(w[0] + 'T12:00:00'); const b = new Date(w[6] + 'T12:00:00'); title = `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` }
  else title = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const gotoMonth = (n) => { const nd = new Date(d); nd.setMonth(nd.getMonth() + n); setViewDate(nd.toISOString().slice(0, 10)) }
  return (
    <div className="topbar">
      <button className="icon-btn" title="Toggle sidebar" onClick={onToggleSidebar}>{sidebarOpen ? '⟨' : '☰'}</button>
      <button className="btn" onClick={() => setViewDate(today)}>Today</button>
      <div className="nav-group">
        <button className="icon-btn" onClick={() => (view === 'month' ? gotoMonth(-1) : setViewDate(addDays(viewDate, -step)))}>‹</button>
        <button className="icon-btn" onClick={() => (view === 'month' ? gotoMonth(1) : setViewDate(addDays(viewDate, step)))}>›</button>
      </div>
      <span className="today-date">{title}</span>
      <div className="spacer" />
      {view !== 'month' && (
        <div className="density">
          <span className="lbl">Density</span>
          <input type="range" min="0.7" max="3" step="0.05" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
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
  const drag = useRef(null)
  const latest = useRef(blocks)
  const [localBlocks, setLocalBlocks] = useState(blocks)
  const [hint, setHint] = useState(null)
  useEffect(() => { latest.current = blocks; setLocalBlocks(blocks) }, [blocks])
  const buffers = useMemo(() => buffersFrom(meetings), [meetings])
  const height = (DAY_END - DAY_START) * zoom
  const hours = []; for (let h = DAY_START; h <= DAY_END; h += 60) hours.push(h)
  const yToMin = (clientY) => clamp(snap(DAY_START + (clientY - ref.current.getBoundingClientRect().top) / zoom), DAY_START, DAY_END - SNAP_MIN)

  function onPointerDown(e, block, mode) {
    e.stopPropagation(); e.preventDefault()
    drag.current = { id: block.id, mode, startY: e.clientY, orig: { ...block }, moved: false }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }
  function onMove(e) {
    const dd = drag.current; if (!dd) return
    if (Math.abs(e.clientY - dd.startY) > 4) dd.moved = true
    const dMin = snap((e.clientY - dd.startY) / zoom)
    const list = latest.current.map((b) => {
      if (b.id !== dd.id) return b
      if (dd.mode === 'move') { const len = dd.orig.end - dd.orig.start; const start = clamp(dd.orig.start + dMin, DAY_START, DAY_END - len); return { ...b, start, end: start + len } }
      if (dd.mode === 'resize-top') { const start = clamp(dd.orig.start + dMin, DAY_START, dd.orig.end - SNAP_MIN); return { ...b, start } }
      return { ...b, end: clamp(dd.orig.end + dMin, dd.orig.start + SNAP_MIN, DAY_END) }
    })
    latest.current = list; setLocalBlocks(list)
  }
  function onUp() {
    const dd = drag.current; drag.current = null
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
    if (dd && dd.moved) onCommit(latest.current)
    else if (dd) { const b = blocks.find((x) => x.id === dd.id); if (b) onEdit(b) }
  }

  return (
    <div className="cal-scroll">
      <div className="grid" ref={ref} style={{ height }}
        onClick={(e) => { if (e.target === ref.current) onCreateAt(yToMin(e.clientY)) }}
        onDragOver={(e) => { e.preventDefault(); setHint(yToMin(e.clientY)) }}
        onDragLeave={(e) => { if (e.target === ref.current) setHint(null) }}
        onDrop={(e) => { e.preventDefault(); setHint(null); try { onDropPayload(JSON.parse(e.dataTransfer.getData('application/json')), yToMin(e.clientY)) } catch {} }}>
        {hours.map((h) => (
          <React.Fragment key={h}>
            <div className="hour-row" style={{ top: (h - DAY_START) * zoom }}><span className="hour-label">{labelShort(h)}</span></div>
            {h < DAY_END && <div className="hour-row half" style={{ top: (h + 30 - DAY_START) * zoom }} />}
          </React.Fragment>
        ))}
        {hint != null && <div className="drop-hint" style={{ top: (hint - DAY_START) * zoom, height: 30 * zoom }}>{label(hint)}</div>}
        {buffers.map((b, i) => <div key={'b' + i} className="ev ev-buffer" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 0, right: 0 }}>Prep · {b.forTitle}</div>)}
        {meetings.map((m) => <div key={m.id} className="ev ev-meeting" style={{ top: (m.start - DAY_START) * zoom, height: (m.end - m.start) * zoom, left: 0, right: 0 }}><div className="ev-title">{m.title}</div><div className="ev-time">{label(m.start)} – {label(m.end)}</div></div>)}
        {localBlocks.map((b) => (
          <div key={b.id} className="ev ev-block" style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, left: 0, right: 0, background: blockColor(b) }}
            onPointerDown={(e) => onPointerDown(e, b, 'move')}>
            <div className="ev-resize-top" onPointerDown={(e) => onPointerDown(e, b, 'resize-top')} />
            <button className="ev-del" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(b.id) }}>×</button>
            <div className="ev-title">{blockName(b)}</div>
            <div className="ev-time">{label(b.start)} – {label(b.end)}</div>
            {Array.isArray(b.tasks) && b.tasks.length > 0 && (b.end - b.start) * zoom > 52 && (
              <div className="ev-tasklist">{b.tasks.slice(0, 4).map((t) => <div key={t.id} className={'ev-task' + (t.status === 'completed' ? ' done' : '')}>• {t.title}</div>)}</div>
            )}
            <div className="ev-resize" onPointerDown={(e) => onPointerDown(e, b, 'resize')} />
          </div>
        ))}
        {day === today && now >= DAY_START && now <= DAY_END && <div className="now-line" style={{ top: (now - DAY_START) * zoom }}><span className="now-dot" /></div>}
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
  const yToMin = (day, clientY) => clamp(snap(DAY_START + (clientY - colRefs.current[day].getBoundingClientRect().top) / zoom), DAY_START, DAY_END - SNAP_MIN)
  return (
    <div className="cal-scroll">
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
          {hours.map((h) => <div key={h} className="hour-row" style={{ top: (h - DAY_START) * zoom, left: 0, right: 'auto', width: 52, borderTop: 'none' }}><span className="hour-label">{labelShort(h)}</span></div>)}
        </div>
        <div className="week-cols">
          {days.map((d) => {
            const meetings = meetingsFor(d); const buffers = buffersFrom(meetings); const bl = blocksByDay[d] || []
            return (
              <div key={d} className={'week-col' + (d === today ? ' is-today' : '')} ref={(el) => (colRefs.current[d] = el)}
                onClick={(e) => { if (e.currentTarget === e.target) onCreateAt(d, yToMin(d, e.clientY)) }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); try { onDropPayload(d, JSON.parse(e.dataTransfer.getData('application/json')), yToMin(d, e.clientY)) } catch {} }}>
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
    projects, onNewProject, onEditProject, onDeleteProject, connected, hasZoho, groups,
    taskFilter, setTaskFilter, taskSearch, setTaskSearch, collapsed, setCollapsed, sections, setSections,
    connections, onOpenConnections, remState, onEnableReminders,
  } = props
  const dragProject = (e, id) => e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'project', projectId: id }))
  const dragTask = (e, task, g, l) => e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'task', task: { ...task, connId: g.id, listId: l.id } }))
  const dragBatch = (e, g, l) => e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'batch', title: l.title, tasks: l.tasks.filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: g.id, listId: l.id })) }))
  const toggleSec = (k) => setSections({ ...sections, [k]: !sections[k] })

  return (
    <aside className="sidebar">
      <div className="brand"><span className="dot" /> Focus Planner</div>

      <div className="sb-fixed">
        <div className="sb-head clickable" onClick={() => toggleSec('projects')}>
          <span>Projects</span><span className="caret">{sections.projects ? '▸' : '▾'}</span>
        </div>
        {!sections.projects && (
          <>
            <div className="proj-list">
              {projects.map((p) => (
                <div key={p.id} className="proj-row" draggable onDragStart={(e) => dragProject(e, p.id)}>
                  <span className="grip">⋮⋮</span>
                  <span className="swatch" style={{ background: p.color }} />
                  <span className="proj-name" onClick={() => onEditProject(p)}>{p.name}</span>
                  <button className="row-x" onClick={() => onDeleteProject(p.id)}>×</button>
                </div>
              ))}
              {projects.length === 0 && <div className="muted" style={{ padding: '2px 8px' }}>No projects yet — drag one onto the grid to block time.</div>}
            </div>
            <button className="btn new-proj" onClick={onNewProject}>＋ New project</button>
          </>
        )}
      </div>

      <div className="sb-tasks">
        <div className="sb-head sticky"><span>Tasks</span>
          <div className="seg">
            <button className={'seg-btn' + (taskFilter === 'all' ? ' on' : '')} onClick={() => setTaskFilter('all')}>All</button>
            <button className={'seg-btn' + (taskFilter === 'today' ? ' on' : '')} onClick={() => setTaskFilter('today')}>Today</button>
          </div>
        </div>
        <div className="task-search"><input className="field" placeholder="Search tasks…" value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} /></div>
        <div className="tgroups">
          {!connected && !hasZoho && <div className="demo-note">Demo tasks — connect an account for your real tasks.</div>}
          {groups.map((g) => (
            <div key={g.id} className="tgroup">
              <div className="tgroup-head">{g.account}</div>
              {g.lists.map((l) => {
                const key = g.id + '/' + l.id; const col = collapsed[key]
                return (
                  <div key={l.id}>
                    <div className="tlist-head" draggable onDragStart={(e) => dragBatch(e, g, l)}>
                      <button className="caret" onClick={() => setCollapsed({ ...collapsed, [key]: !col })}>{col ? '▸' : '▾'}</button>
                      <span className="tlist-title">{l.title}</span><span className="tlist-count">{l.tasks.length}</span>
                    </div>
                    {!col && l.tasks.map((t) => (
                      <div key={t.id} className="titem" draggable onDragStart={(e) => dragTask(e, t, g, l)}>
                        <span className="tdot" /><span>{t.title}{t.sub ? <div className="tsub">{t.sub}</div> : null}</span>
                      </div>
                    ))}
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
          <span className="gear">⚙</span> Connections{connections.length ? <span className="conn-count">{connections.length}</span> : ''}
        </button>
        {remState !== 'granted' && <button className="link" style={{ marginTop: 8 }} onClick={onEnableReminders} disabled={remState === 'unsupported'}>Enable reminders</button>}
      </div>
    </aside>
  )
}

/* ---- Modals ---- */
function ProviderGlyph({ provider }) {
  if (provider === 'zoho') return <span className="pglyph zoho">Z</span>
  return <span className="pglyph google">G</span>
}

function ConnectionsModal({ connections, onDisconnect, calAccounts, selectedCalendars, toggleCalendar, onClose }) {
  const [feats, setFeats] = useState({ calendar: true, tasks: true })
  const [open, setOpen] = useState(null)
  const googleHref = `/api/google/start?feats=${[feats.calendar && 'calendar', feats.tasks && 'tasks'].filter(Boolean).join(',') || 'tasks'}`
  const calsFor = (connId) => calAccounts.find((a) => a.connId === connId)?.calendars || []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal conn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="conn-modal-head">
          <div className="modal-title">Connections</div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="conn-body">
          {connections.length === 0 && <div className="muted" style={{ padding: '4px 2px 12px' }}>No accounts connected yet. Add one below.</div>}

          {connections.map((c) => {
            const cfeats = c.extra?.features || ['calendar', 'tasks']
            const cals = c.provider === 'google' && cfeats.includes('calendar') ? calsFor(c.id) : []
            const expandable = cals.length > 0
            const isOpen = open === c.id
            return (
              <div key={c.id} className={'conn-card' + (isOpen ? ' open' : '')}>
                <div className={'conn-card-head' + (expandable ? ' clickable' : '')} onClick={() => expandable && setOpen(isOpen ? null : c.id)}>
                  <ProviderGlyph provider={c.provider} />
                  <div className="conn-card-id">
                    <div className="conn-card-email">{c.account_label || c.provider}</div>
                    <div className="conn-card-badges">
                      {c.provider === 'google'
                        ? cfeats.map((f) => <span key={f} className="conn-badge">{f}</span>)
                        : <span className="conn-badge">deals · leads · projects</span>}
                      {expandable && <span className="conn-badge">{cals.length} calendars</span>}
                    </div>
                  </div>
                  {expandable && <span className="conn-chev">{isOpen ? '▴' : '▾'}</span>}
                  <button className="link danger" onClick={(e) => { e.stopPropagation(); onDisconnect(c.id) }}>Disconnect</button>
                </div>
                {expandable && isOpen && (
                  <div className="conn-cals">
                    <div className="field-label">Calendars shown on the grid</div>
                    {cals.map((cal) => { const key = `${c.id}::${cal.id}`; return (
                      <label key={cal.id} className="cal-row">
                        <input type="checkbox" checked={selectedCalendars.includes(key)} onChange={() => toggleCalendar(key)} />
                        <span className="swatch" style={{ background: cal.color || '#888' }} />{cal.summary}
                      </label>
                    ) })}
                  </div>
                )}
              </div>
            )
          })}

          <div className="conn-add">
            <div className="conn-card add">
              <div className="conn-card-head"><ProviderGlyph provider="google" /><div className="conn-card-id"><div className="conn-card-email">Add a Google account</div><div className="muted" style={{ fontSize: 12 }}>Choose what to sync</div></div></div>
              <div className="conn-featrow">
                <label className="chk"><input type="checkbox" checked={feats.calendar} onChange={(e) => setFeats({ ...feats, calendar: e.target.checked })} /> Calendar</label>
                <label className="chk"><input type="checkbox" checked={feats.tasks} onChange={(e) => setFeats({ ...feats, tasks: e.target.checked })} /> Tasks</label>
              </div>
              <a className={'btn primary' + (!feats.calendar && !feats.tasks ? ' disabled' : '')} href={googleHref}
                onClick={(e) => { if (!feats.calendar && !feats.tasks) e.preventDefault() }}>Connect Google</a>
            </div>
            <div className="conn-card add">
              <div className="conn-card-head"><ProviderGlyph provider="zoho" /><div className="conn-card-id"><div className="conn-card-email">Add Zoho</div><div className="muted" style={{ fontSize: 12 }}>Deals, leads & projects</div></div></div>
              <a className="btn primary" href="/api/zoho/start">Connect Zoho</a>
            </div>
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
        <div className="modal-title">{p.isNew ? 'New project' : 'Edit project'}</div>
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

function BlockModal({ entry, projects, onSave, onDelete, onClose }) {
  const [b, setB] = useState({ ...entry.block })
  const isProject = !!b.projectId
  const proj = projects.find((p) => p.id === b.projectId)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Edit block</div>
        {isProject
          ? <div><div className="field-label">Project</div><div className="field" style={{ background: 'var(--panel-2)' }}>{proj?.name || 'Project'}</div></div>
          : <div><div className="field-label">Title</div><input className="field" value={b.title || ''} onChange={(e) => setB({ ...b, title: e.target.value })} /></div>}
        <div className="modal-row">
          <div style={{ flex: 1 }}><div className="field-label">Start</div><input type="time" className="field" step="900" value={minToTime(b.start)} onChange={(e) => setB({ ...b, start: timeToMin(e.target.value) })} /></div>
          <div style={{ flex: 1 }}><div className="field-label">End</div><input type="time" className="field" step="900" value={minToTime(b.end)} onChange={(e) => setB({ ...b, end: Math.max(timeToMin(e.target.value), b.start + SNAP_MIN) })} /></div>
        </div>
        {!isProject && <div><div className="field-label">Color</div><div className="swatches">{PALETTE.map((c) => <button key={c} className={'swatch-btn' + (b.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setB({ ...b, color: c })} />)}</div></div>}
        {Array.isArray(b.tasks) && b.tasks.length > 0 && <div className="muted">{b.tasks.length} task{b.tasks.length > 1 ? 's' : ''} in this block</div>}
        <div className="modal-actions"><button className="link danger" onClick={onDelete}>Delete</button><div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(b)}>Save</button></div>
      </div>
    </div>
  )
}
