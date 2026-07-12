import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, logout } from '../lib/api.js'
import { MOCK_MEETINGS, MOCK_TASK_GROUPS } from '../lib/mock.js'
import {
  PALETTE, DAY_START, DAY_END, SNAP_MIN, ACCENT,
  isoDate, addDays, weekDays, label, labelShort, snap, clamp, hexA, uuid,
  buffersFrom, computeFocus, nowMinutes,
} from '../lib/lib.js'
import FocusCard from './FocusCard.jsx'

const DEFAULT_TZ = 'America/New_York'

export default function Planner({ onLoggedOut }) {
  const [tz, setTz] = useState(DEFAULT_TZ)
  const [projects, setProjects] = useState([])
  const [blocks, setBlocks] = useState({}) // { iso: [block] }
  const [connections, setConnections] = useState([])
  const [storageOk, setStorageOk] = useState(true)
  const [banner, setBanner] = useState('')

  const [viewDate, setViewDate] = useState(() => isoDate(new Date(), DEFAULT_TZ))
  const [view, setView] = useState('day')
  const [zoom] = useState(1.6)
  const [now, setNow] = useState(() => nowMinutes(DEFAULT_TZ))

  const [taskFilter, setTaskFilter] = useState('all')
  const [collapsed, setCollapsed] = useState({})
  const [focusHidden, setFocusHidden] = useState(false)
  const [overrideBlockId, setOverrideBlockId] = useState(null)
  const [editProject, setEditProject] = useState(null)

  const today = isoDate(new Date(), tz)

  // --- boot -----------------------------------------------------------------
  useEffect(() => {
    ;(async () => {
      try {
        const { state } = await api.get('/api/data')
        if (state.timezone) setTz(state.timezone)
        setProjects(state.projects || [])
        setBlocks(state.blocks || {})
        setStorageOk(true)
      } catch {
        setStorageOk(false) // works in-memory until Blob/login is wired
      }
      try {
        const { connections } = await api.get('/api/connections')
        setConnections(connections || [])
      } catch {}
      // ?connected=google&status=ok banner, then clean the URL
      const p = new URLSearchParams(location.search)
      if (p.get('connected')) {
        setBanner(`${p.get('connected')} connected`)
        history.replaceState({}, '', location.pathname)
      }
    })()
  }, [])

  // --- live clock -----------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => setNow(nowMinutes(tz)), 30000)
    setNow(nowMinutes(tz))
    return () => clearInterval(id)
  }, [tz])

  // --- debounced, serialized saver -----------------------------------------
  const pending = useRef(new Map())
  const timer = useRef(null)
  const flushing = useRef(false)
  function saveKey(key, value) {
    if (!storageOk) return
    pending.current.set(key, value)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 400)
  }
  async function flush() {
    if (flushing.current) return
    flushing.current = true
    try {
      while (pending.current.size) {
        const [key, value] = pending.current.entries().next().value
        pending.current.delete(key)
        try {
          await api.post('/api/data', { key, value })
        } catch {
          setStorageOk(false)
        }
      }
    } finally {
      flushing.current = false
    }
  }

  // --- mutations ------------------------------------------------------------
  function updateProjects(next) {
    setProjects(next)
    saveKey('projects', next)
  }
  function updateBlocks(next) {
    setBlocks(next)
    saveKey('blocks', next)
  }
  function setDayBlocks(iso, list) {
    updateBlocks({ ...blocks, [iso]: list })
  }
  const dayBlocks = blocks[viewDate] || []

  function addProject(name) {
    const p = { id: uuid(), name, color: PALETTE[projects.length % PALETTE.length], note: '' }
    updateProjects([...projects, p])
  }
  function saveProject(p) {
    updateProjects(projects.map((x) => (x.id === p.id ? p : x)))
    setEditProject(null)
  }
  function deleteProject(id) {
    updateProjects(projects.filter((x) => x.id !== id))
  }

  // --- meetings + buffers (mock until Google is wired) ----------------------
  const meetings = useMemo(() => (viewDate === today ? MOCK_MEETINGS : []), [viewDate, today])
  const buffers = useMemo(() => buffersFrom(meetings), [meetings])

  // --- tasks sidebar (mock until Google) ------------------------------------
  const taskGroups = MOCK_TASK_GROUPS

  // --- focus ----------------------------------------------------------------
  const focus = useMemo(() => {
    const todays = blocks[today] || []
    if (overrideBlockId) {
      const b = todays.find((x) => x.id === overrideBlockId)
      if (b) return computeFocus({ blocks: [b], meetings: [], buffers: [], now: b.start, projects })
    }
    return computeFocus({ blocks: todays, meetings: viewDate === today ? meetings : MOCK_MEETINGS, buffers, now, projects })
  }, [blocks, today, overrideBlockId, meetings, buffers, now, projects, viewDate])

  function advanceToNext() {
    const todays = [...(blocks[today] || [])].sort((a, b) => a.start - b.start)
    const ref = overrideBlockId ? todays.find((b) => b.id === overrideBlockId)?.start ?? now : now
    const next = todays.find((b) => b.start > ref)
    if (next) setOverrideBlockId(next.id) // does NOT touch the current block's tasks
  }

  function applyTaskCompletion(connId, listId, taskId, completed) {
    // 1 + 2: optimistic update inside blocks (sidebar mock is static here)
    const next = { ...blocks }
    for (const iso of Object.keys(next)) {
      next[iso] = next[iso].map((b) =>
        Array.isArray(b.tasks)
          ? { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, status: completed ? 'completed' : 'needsAction' } : t)) }
          : b,
      )
    }
    updateBlocks(next)
    // 3: write-back to Google (Phase 4 endpoint; ignored if not present yet)
    api.post('/api/google/data', { action: 'complete', connId, listId, taskId, completed }).catch(() => {})
  }

  // --- drop from sidebar ----------------------------------------------------
  const gridRef = useRef(null)
  function yToMin(clientY) {
    const rect = gridRef.current.getBoundingClientRect()
    const min = DAY_START + (clientY - rect.top) / zoom
    return clamp(snap(min), DAY_START, DAY_END - SNAP_MIN)
  }
  function onDrop(e) {
    e.preventDefault()
    let payload
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/json'))
    } catch {
      return
    }
    const start = yToMin(e.clientY)
    if (payload.kind === 'project') {
      addBlock({ id: uuid(), start, end: Math.min(start + 60, DAY_END), projectId: payload.projectId })
    } else if (payload.kind === 'task') {
      addBlock({ id: uuid(), start, end: Math.min(start + 30, DAY_END), tasks: [payload.task] })
    } else if (payload.kind === 'batch') {
      const dur = clamp(payload.tasks.length * 30, 30, 240)
      addBlock({
        id: uuid(), start, end: Math.min(start + dur, DAY_END),
        title: payload.title, color: '#039BE5', tasks: payload.tasks,
      })
    }
  }
  function addBlock(b) {
    setDayBlocks(viewDate, [...dayBlocks, b])
  }
  function deleteBlock(id) {
    setDayBlocks(viewDate, dayBlocks.filter((b) => b.id !== id))
  }

  // --- block drag / resize --------------------------------------------------
  const blockDrag = useRef(null)
  function onBlockPointerDown(e, block, mode) {
    e.stopPropagation()
    e.preventDefault()
    blockDrag.current = { id: block.id, mode, startY: e.clientY, orig: { ...block }, moved: false }
    window.addEventListener('pointermove', onBlockPointerMove)
    window.addEventListener('pointerup', onBlockPointerUp)
  }
  function onBlockPointerMove(e) {
    const d = blockDrag.current
    if (!d) return
    const dMin = snap((e.clientY - d.startY) / zoom)
    if (Math.abs(e.clientY - d.startY) > 5) d.moved = true
    setDayBlocks(
      viewDate,
      (blocks[viewDate] || []).map((b) => {
        if (b.id !== d.id) return b
        if (d.mode === 'move') {
          const len = d.orig.end - d.orig.start
          let start = clamp(d.orig.start + dMin, DAY_START, DAY_END - len)
          return { ...b, start, end: start + len }
        }
        const end = clamp(d.orig.end + dMin, d.orig.start + SNAP_MIN, DAY_END)
        return { ...b, end }
      }),
    )
  }
  function onBlockPointerUp() {
    const d = blockDrag.current
    blockDrag.current = null
    window.removeEventListener('pointermove', onBlockPointerMove)
    window.removeEventListener('pointerup', onBlockPointerUp)
    if (d) saveKey('blocks', blocks) // persist final position
  }

  // --- reminders ------------------------------------------------------------
  const [remState, setRemState] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  )
  function enableReminders() {
    if (typeof Notification === 'undefined') return
    Notification.requestPermission().then((p) => {
      setRemState(p)
      if (p === 'granted') scheduleReminders()
    })
  }
  function scheduleReminders() {
    const todays = blocks[today] || []
    const cur = nowMinutes(tz)
    for (const b of todays) {
      const delay = (b.start - cur) * 60000
      if (delay <= 0 || delay > 12 * 3600000) continue
      const name = b.title || projects.find((p) => p.id === b.projectId)?.name || 'Focus block'
      setTimeout(() => new Notification('Focus Planner', { body: `${label(b.start)} — ${name}` }), delay)
    }
  }

  async function doLogout() {
    await logout().catch(() => {})
    onLoggedOut()
  }

  // --- render ---------------------------------------------------------------
  const gridHeight = (DAY_END - DAY_START) * zoom
  const hours = []
  for (let h = DAY_START; h <= DAY_END; h += 60) hours.push(h)

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        onAddProject={addProject}
        onEditProject={setEditProject}
        onDeleteProject={deleteProject}
        taskGroups={taskGroups}
        taskFilter={taskFilter}
        setTaskFilter={setTaskFilter}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        connections={connections}
        remState={remState}
        onEnableReminders={enableReminders}
        onLogout={doLogout}
      />

      <main className="main">
        <Toolbar
          view={view}
          setView={setView}
          viewDate={viewDate}
          setViewDate={setViewDate}
          today={today}
          tz={tz}
        />
        {!storageOk && (
          <div className="warn-banner">
            Not connected to storage — changes are in-memory only. Finish Vercel Blob + login setup (Phase 1–2) to persist.
          </div>
        )}
        {banner && <div className="ok-banner">{banner}</div>}

        {view === 'day' ? (
          <div className="grid-scroll">
            <div className="grid" ref={gridRef} style={{ height: gridHeight }}
              onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
              {hours.map((h) => (
                <div key={h} className="hour-row" style={{ top: (h - DAY_START) * zoom }}>
                  <span className="hour-label">{labelShort(h)}</span>
                </div>
              ))}

              {buffers.map((b, i) => (
                <div key={'buf' + i} className="ev-buffer"
                  style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom }}>
                  Prep · {b.forTitle}
                </div>
              ))}

              {meetings.map((m) => (
                <div key={m.id} className="ev-meeting"
                  style={{ top: (m.start - DAY_START) * zoom, height: (m.end - m.start) * zoom }}>
                  <div className="ev-title">{m.title}</div>
                  <div className="ev-time">{label(m.start)}–{label(m.end)}</div>
                </div>
              ))}

              {dayBlocks.map((b) => {
                const proj = projects.find((p) => p.id === b.projectId)
                const color = b.color || proj?.color || '#0B8043'
                const name = b.title || proj?.name || (b.tasks?.length === 1 ? b.tasks[0].title : `${b.tasks?.length || 0} tasks`)
                return (
                  <div key={b.id} className="ev-block"
                    style={{ top: (b.start - DAY_START) * zoom, height: (b.end - b.start) * zoom, background: color }}
                    onPointerDown={(e) => onBlockPointerDown(e, b, 'move')}>
                    <button className="ev-del" title="Delete"
                      onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteBlock(b.id)}>×</button>
                    <div className="ev-title">{name}</div>
                    <div className="ev-time">{label(b.start)}–{label(b.end)}</div>
                    {Array.isArray(b.tasks) && b.tasks.length > 0 && (
                      <div className="ev-tasklist">
                        {b.tasks.map((t) => (
                          <div key={t.id} className={'ev-task' + (t.status === 'completed' ? ' done' : '')}>• {t.title}</div>
                        ))}
                      </div>
                    )}
                    <div className="ev-resize" onPointerDown={(e) => onBlockPointerDown(e, b, 'resize')} />
                  </div>
                )
              })}

              {viewDate === today && now >= DAY_START && now <= DAY_END && (
                <div className="now-line" style={{ top: (now - DAY_START) * zoom }}>
                  <span className="now-dot" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <WeekView viewDate={viewDate} blocks={blocks} projects={projects} today={today}
            onPickDay={(d) => { setViewDate(d); setView('day') }} />
        )}
      </main>

      {!focusHidden && (
        <FocusCard focus={focus} now={now}
          onToggleTask={(t) => applyTaskCompletion(t.connId, t.listId, t.id, t.status !== 'completed')}
          onNext={advanceToNext} onHide={() => setFocusHidden(true)} />
      )}
      {focusHidden && (
        <button className="focus-show" onClick={() => setFocusHidden(false)}>Show focus</button>
      )}

      {editProject && (
        <ProjectModal project={editProject} onSave={saveProject} onClose={() => setEditProject(null)} onDelete={deleteProject} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Toolbar({ view, setView, viewDate, setViewDate, today, tz }) {
  const d = new Date(viewDate + 'T12:00:00')
  const long = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  return (
    <div className="toolbar">
      <button className="pill" onClick={() => setViewDate(today)}>Today</button>
      <button className="pill-icon" onClick={() => setViewDate(addDays(viewDate, view === 'week' ? -7 : -1))}>‹</button>
      <button className="pill-icon" onClick={() => setViewDate(addDays(viewDate, view === 'week' ? 7 : 1))}>›</button>
      <span className="toolbar-date">{long}</span>
      <div className="toolbar-spacer" />
      <div className="seg">
        <button className={'seg-btn' + (view === 'day' ? ' on' : '')} onClick={() => setView('day')}>Day</button>
        <button className={'seg-btn' + (view === 'week' ? ' on' : '')} onClick={() => setView('week')}>Week</button>
      </div>
    </div>
  )
}

function Sidebar(props) {
  const {
    projects, onAddProject, onEditProject, onDeleteProject,
    taskGroups, taskFilter, setTaskFilter, collapsed, setCollapsed,
    connections, remState, onEnableReminders, onLogout,
  } = props
  const [newName, setNewName] = useState('')

  function dragProject(e, id) {
    e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'project', projectId: id }))
  }
  function dragTask(e, task, group, list) {
    const t = { ...task, connId: group.id, listId: list.id }
    e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'task', task: t }))
  }
  function dragBatch(e, group, list) {
    const tasks = list.tasks.filter((t) => t.status !== 'completed').map((t) => ({ ...t, connId: group.id, listId: list.id }))
    e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'batch', title: list.title, tasks }))
  }

  return (
    <aside className="sidebar">
      <div className="brand">Focus Planner</div>

      <section>
        <div className="sec-head">Projects</div>
        <div className="project-list">
          {projects.map((p) => (
            <div key={p.id} className="project-row" draggable onDragStart={(e) => dragProject(e, p.id)}>
              <span className="swatch" style={{ background: p.color }} />
              <span className="project-name" onClick={() => onEditProject(p)}>{p.name}</span>
              <button className="row-x" onClick={() => onDeleteProject(p.id)}>×</button>
            </div>
          ))}
        </div>
        <form className="add-row" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { onAddProject(newName.trim()); setNewName('') } }}>
          <input className="underline-input sm" placeholder="＋ Add project" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </form>
      </section>

      <section>
        <div className="sec-head">
          Tasks
          <div className="seg sm">
            <button className={'seg-btn' + (taskFilter === 'all' ? ' on' : '')} onClick={() => setTaskFilter('all')}>All</button>
            <button className={'seg-btn' + (taskFilter === 'today' ? ' on' : '')} onClick={() => setTaskFilter('today')}>Today</button>
          </div>
        </div>
        <div className="demo-note">Demo tasks — real Google/Zoho tasks arrive in Phase 4–5.</div>
        {taskGroups.map((g) => (
          <div key={g.id} className="task-group">
            <div className="group-head">{g.account}</div>
            {g.lists.map((list) => {
              const key = g.id + '/' + list.id
              const isCollapsed = collapsed[key]
              return (
                <div key={list.id} className="task-list">
                  <div className="list-head" draggable onDragStart={(e) => dragBatch(e, g, list)}>
                    <button className="caret" onClick={() => setCollapsed({ ...collapsed, [key]: !isCollapsed })}>
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                    <span className="list-title">{list.title}</span>
                    <span className="list-count">{list.tasks.length}</span>
                  </div>
                  {!isCollapsed && list.tasks.map((t) => (
                    <div key={t.id} className="task-item" draggable onDragStart={(e) => dragTask(e, t, g, list)}>
                      <span className="dot" /> {t.title}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
      </section>

      <section>
        <div className="sec-head">Connections</div>
        {connections.length === 0 && <div className="muted">No accounts connected.</div>}
        {connections.map((c) => (
          <div key={c.id} className="conn-row">{c.account_label || c.provider}</div>
        ))}
        <a className="btn-connect" href="/api/google/start">Connect Google</a>
        <a className="btn-connect" href="/api/zoho/start">Connect Zoho</a>
      </section>

      <section>
        <div className="sec-head">Reminders</div>
        {remState === 'granted' ? (
          <div className="muted">On. Only fire while a tab is open (browser limit).</div>
        ) : (
          <>
            <button className="btn-secondary" onClick={onEnableReminders} disabled={remState === 'unsupported'}>
              Enable reminders
            </button>
            <div className="muted">Only fire while a tab is open (browser limit).</div>
          </>
        )}
      </section>

      <div className="sidebar-foot">
        <button className="link-btn" onClick={onLogout}>Log out</button>
      </div>
    </aside>
  )
}

function WeekView({ viewDate, blocks, projects, today, onPickDay }) {
  const days = weekDays(viewDate)
  return (
    <div className="week">
      {days.map((d) => {
        const list = [...(blocks[d] || [])].sort((a, b) => a.start - b.start)
        const dd = new Date(d + 'T12:00:00')
        return (
          <div key={d} className={'week-col' + (d === today ? ' is-today' : '')} onClick={() => onPickDay(d)}>
            <div className="week-head">
              <div className="week-dow">{dd.toLocaleDateString('en-US', { weekday: 'short' })}</div>
              <div className="week-num">{dd.getDate()}</div>
            </div>
            <div className="week-body">
              {list.map((b) => {
                const proj = projects.find((p) => p.id === b.projectId)
                const color = b.color || proj?.color || '#0B8043'
                const name = b.title || proj?.name || `${b.tasks?.length || 0} tasks`
                return (
                  <div key={b.id} className="week-chip" style={{ background: color }}>
                    {labelShort(b.start)} {name}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ProjectModal({ project, onSave, onClose, onDelete }) {
  const [p, setP] = useState({ ...project })
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Edit project</div>
        <input className="underline-input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Name" />
        <input className="underline-input" value={p.note || ''} onChange={(e) => setP({ ...p, note: e.target.value })} placeholder="Note (shows on the focus card)" />
        <div className="swatches">
          {PALETTE.map((c) => (
            <button key={c} className={'swatch-btn' + (p.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setP({ ...p, color: c })} />
          ))}
        </div>
        <div className="modal-actions">
          <button className="link-btn danger" onClick={() => { onDelete(p.id); onClose() }}>Delete</button>
          <div className="toolbar-spacer" />
          <button className="link-btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary sm" onClick={() => onSave(p)} style={{ background: ACCENT }}>Save</button>
        </div>
      </div>
    </div>
  )
}
