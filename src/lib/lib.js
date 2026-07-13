// Shared constants + pure helpers for the planner.
import { toLocalMinutes, localDateISO, nowMinutes } from '../../shared/time.js'

export { toLocalMinutes, localDateISO, nowMinutes }

export const PALETTE = [
  '#6d5efc', '#ff6b9d', '#14c8a6', '#ffa63d', '#ff5a5f',
  '#00b8d9', '#7c4dff', '#f6c445', '#36b37e', '#8892a6',
]

export const DAY_START = 7 * 60 // 7:00am
export const DAY_END = 22 * 60 // 10:00pm
export const SNAP_MIN = 15
export const BUFFER_MIN = 15

export const ACCENT = '#6d5efc'

// --- date helpers (operate on "YYYY-MM-DD" strings) -------------------------

// Parse a plain date string at UTC noon (DST-safe for day arithmetic).
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
}

export function isoDate(date, tz) {
  return localDateISO(date, tz)
}

export function addDays(iso, n) {
  const d = parseISO(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Add `n` calendar months, clamping the day to the target month's length
// (so Jan 31 + 1 = Feb 28/29, never skipping to March). UTC-based like addDays.
export function addMonths(iso, n) {
  const d = parseISO(iso)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + n)
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, daysInMonth))
  return d.toISOString().slice(0, 10)
}

// Sunday-based start of week for an ISO date.
export function startOfWeek(iso) {
  const d = parseISO(iso)
  return addDays(iso, -d.getUTCDay()) // 0 = Sunday
}

export function sameDay(a, b) {
  return a === b
}

export function weekDays(iso) {
  const start = startOfWeek(iso)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

// 6x7 = 42 day grid (Sun-first) covering the month that contains `iso`.
export function monthGridDays(iso) {
  const d = parseISO(iso)
  const firstOfMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
  const firstDow = parseISO(firstOfMonth).getUTCDay() // 0 = Sun
  const gridStart = addDays(firstOfMonth, -firstDow)
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

export function monthOf(iso) {
  return iso.slice(0, 7) // "YYYY-MM"
}

export function dayNum(iso) {
  return Number(iso.slice(8, 10))
}

// --- time formatting --------------------------------------------------------

export function label(min) {
  const h24 = Math.floor(min / 60)
  const m = min % 60
  const ampm = h24 >= 12 ? 'PM' : 'AM'
  let h = h24 % 12
  if (h === 0) h = 12
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`
}

// Whole-hour axis label: "7 AM", "12 PM", "1 PM"
export function hourLabel(min) {
  const h24 = Math.floor(min / 60)
  const ampm = h24 >= 12 ? 'PM' : 'AM'
  let h = h24 % 12
  if (h === 0) h = 12
  return `${h} ${ampm}`
}

export function labelShort(min) {
  const h24 = Math.floor(min / 60)
  const m = min % 60
  const ampm = h24 >= 12 ? 'p' : 'a'
  let h = h24 % 12
  if (h === 0) h = 12
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`
}

// --- geometry ---------------------------------------------------------------

export function snap(min, step = SNAP_MIN) {
  return Math.round(min / step) * step
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end
}

// hex + alpha (0..1) -> rgba() string
export function hexA(hex, alpha) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// --- prep buffers -----------------------------------------------------------

// Prep buffers before and/or after each meeting, each trimmed so it never
// overlaps an adjacent meeting. cfg = { before, after } in minutes (0 = off).
export function buffersFrom(meetings, cfg) {
  const before = cfg ? (cfg.before || 0) : BUFFER_MIN
  const after = cfg ? (cfg.after || 0) : 0
  const sorted = [...meetings].sort((a, b) => a.start - b.start)
  const out = []
  for (const m of sorted) {
    if (before > 0) {
      let start = m.start - before
      for (const other of sorted) { if (other === m) continue; if (other.end <= m.start && other.end > start) start = other.end }
      if (start < m.start) out.push({ start, end: m.start, forTitle: m.title, kind: 'before' })
    }
    if (after > 0) {
      let end = m.end + after
      for (const other of sorted) { if (other === m) continue; if (other.start >= m.end && other.start < end) end = other.start }
      if (end > m.end) out.push({ start: m.end, end, forTitle: m.title, kind: 'after' })
    }
  }
  return out
}

// --- collision-free placement ----------------------------------------------

// Free gaps in [lo,hi] given occupied intervals.
export function freeGaps(occupied, lo = DAY_START, hi = DAY_END) {
  const s = [...occupied].sort((a, b) => a.start - b.start)
  const gaps = []
  let cur = lo
  for (const o of s) { if (o.start > cur) gaps.push({ start: cur, end: o.start }); cur = Math.max(cur, o.end) }
  if (cur < hi) gaps.push({ start: cur, end: hi })
  return gaps
}

// Where a dropped block should land: snap start into free space, size to the
// gap (default `preferred`, capped by available room, min one snap). null = no room.
export function fitDrop(occupied, start, preferred = 60) {
  const s = [...occupied].sort((a, b) => a.start - b.start)
  let st = snap(start)
  for (const o of s) if (st >= o.start && st < o.end) st = o.end // pushed out of an occupied slot
  let next = DAY_END
  for (const o of s) if (o.start >= st && o.start < next) next = o.start
  const avail = next - st
  if (avail < SNAP_MIN) return null
  return { start: st, end: st + clamp(preferred, SNAP_MIN, avail) }
}

// Nearest non-overlapping placement for a moved block of length `len`.
export function clampMove(occupied, start, len) {
  const gaps = freeGaps(occupied).filter((g) => g.end - g.start >= len)
  if (!gaps.length) return null
  let best = null, bd = Infinity
  for (const g of gaps) { const cs = clamp(start, g.start, g.end - len); const d = Math.abs(cs - start); if (d < bd) { bd = d; best = cs } }
  return { start: best, end: best + len }
}

export function clampResizeBottom(occupied, start, desiredEnd) {
  let next = DAY_END
  for (const o of occupied) if (o.start >= start && o.start < next) next = o.start
  return clamp(desiredEnd, start + SNAP_MIN, next)
}

export function clampResizeTop(occupied, end, desiredStart) {
  let prev = DAY_START
  for (const o of occupied) if (o.end <= end && o.end > prev) prev = o.end
  return clamp(desiredStart, prev, end - SNAP_MIN)
}

// --- the focus brain --------------------------------------------------------

function within(now, item) {
  return now >= item.start && now < item.end
}

// Given today's blocks/meetings/buffers and the current minute, decide what
// the focus card shows. Priority: meeting > buffer > task block > project
// block > open time.
export function computeFocus({ blocks = [], meetings = [], buffers = [], now, projects = [] }) {
  const meeting = meetings.find((m) => within(now, m))
  if (meeting) {
    return {
      color: '#616161', label: meeting.title || 'Meeting', sub: 'In a meeting',
      tasks: [], block: null, event: meeting, link: meeting.link || null, location: meeting.location || null,
    }
  }
  // Not in a meeting now, but one is coming up soon — surface it so the link is handy.
  const soon = meetings
    .filter((m) => m.start > now && m.start - now <= 30)
    .sort((a, b) => a.start - b.start)[0]
  if (soon) {
    return {
      color: '#E67C00', label: soon.title || 'Upcoming meeting', sub: `Starts at ${label(soon.start)}`,
      tasks: [], block: null, event: soon, link: soon.link || null, location: soon.location || null,
    }
  }

  const buffer = buffers.find((b) => within(now, b))
  if (buffer) {
    return {
      color: '#E67C00',
      label: buffer.forTitle || 'Upcoming meeting',
      sub: `${buffer.kind === 'after' ? 'Wrap-up' : 'Prep'} · ${buffer.end - buffer.start} min`,
      tasks: [],
      block: null,
    }
  }

  const block = blocks.find((b) => within(now, b))
  if (block) {
    if (Array.isArray(block.tasks)) {
      const tasks = block.tasks
      const left = tasks.filter((t) => t.status !== 'completed').length
      let name = block.title
      if (!name) name = tasks.length === 1 ? tasks[0].title : `${tasks.length} tasks`
      return {
        color: block.color || '#039BE5',
        label: name,
        sub: `${left} of ${tasks.length} left`,
        tasks,
        block,
      }
    }
    const project = projects.find((p) => p.id === block.projectId)
    return {
      color: project?.color || '#0B8043',
      label: project?.name || 'Project',
      sub: 'Focus now',
      note: project?.note || '',
      tasks: [],
      block,
    }
  }

  return { color: '#5F6368', label: 'Open time', sub: 'Nothing scheduled', tasks: [], block: null }
}
