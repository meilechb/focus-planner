// Shared constants + pure helpers for the planner.
import { toLocalMinutes, localDateISO, nowMinutes } from '../../shared/time.js'

export { toLocalMinutes, localDateISO, nowMinutes }

export const PALETTE = [
  '#D50000', '#E67C00', '#F09300', '#33B679', '#0B8043',
  '#039BE5', '#3F51B5', '#7986CB', '#8E24AA', '#616161',
]

export const DAY_START = 7 * 60 // 7:00am
export const DAY_END = 22 * 60 // 10:00pm
export const SNAP_MIN = 15
export const BUFFER_MIN = 15

export const ACCENT = '#1A73E8'

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

// Monday-based start of week for an ISO date.
export function startOfWeek(iso) {
  const d = parseISO(iso)
  const day = (d.getUTCDay() + 6) % 7 // 0 = Monday
  return addDays(iso, -day)
}

export function sameDay(a, b) {
  return a === b
}

export function weekDays(iso) {
  const start = startOfWeek(iso)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
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

// A 15-min prep buffer before each meeting, trimmed so it never overlaps an
// earlier meeting.
export function buffersFrom(meetings) {
  const sorted = [...meetings].sort((a, b) => a.start - b.start)
  const out = []
  for (const m of sorted) {
    let start = m.start - BUFFER_MIN
    // don't run the buffer back into a previous meeting
    for (const other of sorted) {
      if (other === m) continue
      if (other.end <= m.start && other.end > start) start = other.end
    }
    if (start < m.start) out.push({ start, end: m.start, forTitle: m.title })
  }
  return out
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
    return { color: '#616161', label: meeting.title || 'Meeting', sub: 'In a meeting', tasks: [], block: null }
  }

  const buffer = buffers.find((b) => within(now, b))
  if (buffer) {
    return {
      color: '#E67C00',
      label: buffer.forTitle || 'Upcoming meeting',
      sub: `Prep · ${BUFFER_MIN} min`,
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
