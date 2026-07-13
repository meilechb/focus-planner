import React, { useEffect, useState } from 'react'
import { computeFocus, buffersFrom, nowMinutes, localDateISO } from '../lib/lib.js'
import FocusCard from './FocusCard.jsx'

// Standalone focus card for the desktop app's always-on-top floating window.
// It renders the very same card the web app shows, but as its own OS-level
// window that floats above every other app. It has no data-fetching of its
// own: it reads the schedule the main window already caches in localStorage
// (`focus_cache` / `focus_navcfg`) and recomputes "what to work on now" on a
// timer, whenever that cache changes, and whenever the window regains focus.

const CACHE_KEY = 'focus_cache'
const NAVCFG_KEY = 'focus_navcfg'
const DEFAULT_BUFFERS = { before: 15, after: 0 }

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} }
}

export default function FocusWindow() {
  // A single counter forces a re-read of the cache + a recompute of `now`.
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)
  const [overrideBlockId, setOverrideBlockId] = useState(null)

  useEffect(() => {
    const id = setInterval(rerender, 15000) // keep the clock + focus fresh
    const onStorage = (e) => { if (!e.key || e.key === CACHE_KEY || e.key === NAVCFG_KEY) rerender() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', rerender)
    window.addEventListener('online', rerender)
    return () => {
      clearInterval(id)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', rerender)
      window.removeEventListener('online', rerender)
    }
  }, [])

  const cache = read(CACHE_KEY)
  const nav = read(NAVCFG_KEY)
  const buffers = nav.buffers || DEFAULT_BUFFERS
  const tz = cache.tz
  const today = localDateISO(new Date(), tz)
  const now = nowMinutes(tz)
  const todays = (cache.blocks && cache.blocks[today]) || []
  const projects = cache.projects || []
  const meetings = (cache.eventsByDate && cache.eventsByDate[today]) || []

  let focus
  if (overrideBlockId) {
    const b = todays.find((x) => x.id === overrideBlockId)
    focus = b
      ? computeFocus({ blocks: [b], meetings: [], buffers: [], now: b.start, projects })
      : computeFocus({ blocks: todays, meetings, buffers: buffersFrom(meetings, buffers), now, projects })
  } else {
    focus = computeFocus({ blocks: todays, meetings, buffers: buffersFrom(meetings, buffers), now, projects })
  }

  // Advance the card to the next scheduled block (mirrors the main app's "Next").
  function advanceToNext() {
    const sorted = [...todays].sort((a, b) => a.start - b.start)
    const ref = overrideBlockId ? (sorted.find((b) => b.id === overrideBlockId)?.start ?? now) : now
    const next = sorted.find((b) => b.start > ref)
    if (next) setOverrideBlockId(next.id)
  }

  // Toggle a task: write the new status into the shared cache (so the main
  // window picks it up via a storage event) and, for Google tasks, tell the
  // backend. Cookies are shared with the main window, so the API call is authed.
  function toggleTask(task) {
    const completed = task.status !== 'completed'
    const status = completed ? 'completed' : 'needsAction'
    const c = read(CACHE_KEY)
    if (c.blocks) {
      for (const iso of Object.keys(c.blocks)) {
        c.blocks[iso] = (c.blocks[iso] || []).map((b) =>
          Array.isArray(b.tasks) ? { ...b, tasks: b.tasks.map((t) => (t.id === task.id ? { ...t, status } : t)) } : b)
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch {}
    }
    if (task.source === 'google' && task.connId && task.listId) {
      fetch('/api/google/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', connId: task.connId, listId: task.listId, taskId: task.id, completed }),
      }).catch(() => {})
    }
    rerender()
  }

  function openEvent() {
    if (focus.event?.link) window.open(focus.event.link, '_blank', 'noopener')
  }

  function hide() {
    if (window.focusDesktop?.hideFocusCard) window.focusDesktop.hideFocusCard()
    else window.close()
  }

  return (
    <FocusCard
      focus={focus}
      now={now}
      onToggleTask={toggleTask}
      onOpenEvent={openEvent}
      onNext={advanceToNext}
      onHide={hide}
      windowMode
    />
  )
}
