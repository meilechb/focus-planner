import React, { useEffect, useRef, useState } from 'react'
import { label } from '../lib/lib.js'
import { Icon } from './Icon.jsx'

const LS_KEY = 'focus_card_box'
const DEFAULT_BOX = { x: null, y: null, w: 300, h: 260 }

function loadBox() {
  try {
    return { ...DEFAULT_BOX, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }
  } catch {
    return { ...DEFAULT_BOX }
  }
}

export default function FocusCard({ focus, now, onToggleTask, onOpenEvent, onNext, onHide, windowMode = false }) {
  const [box, setBox] = useState(loadBox)
  const drag = useRef(null)

  const persist = (b) => { try { localStorage.setItem(LS_KEY, JSON.stringify(b)) } catch {} }

  // Keep the card on-screen: default to bottom-right if never positioned, and
  // re-clamp into the viewport on mount and whenever the window resizes (a box
  // saved on a bigger window could otherwise render fully off-screen).
  useEffect(() => {
    const clampIn = () => setBox((b) => {
      const w = b.w, h = b.h
      const x = b.x == null ? window.innerWidth - w - 24 : Math.min(Math.max(0, b.x), Math.max(0, window.innerWidth - w))
      const y = b.y == null ? window.innerHeight - h - 24 : Math.min(Math.max(0, b.y), Math.max(0, window.innerHeight - h))
      const next = { ...b, x, y }
      persist(next)
      return next
    })
    clampIn()
    window.addEventListener('resize', clampIn)
    return () => window.removeEventListener('resize', clampIn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onPointerDown(e, mode) {
    e.preventDefault()
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box: { ...box },
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }
  function onPointerMove(e) {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'move') {
      setBox((b) => ({ ...b, x: d.box.x + dx, y: d.box.y + dy }))
    } else {
      setBox((b) => ({
        ...b,
        w: Math.max(220, d.box.w + dx),
        h: Math.max(160, d.box.h + dy),
      }))
    }
  }
  function onPointerUp() {
    drag.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    setBox((b) => { persist(b); return b }) // save once, at the end of the gesture
  }

  // In window mode the OS window is the frame: fill it and let the native
  // title-bar drag region move it, so we skip the in-page position/resize box.
  const style = windowMode
    ? { background: focus.color }
    : {
        left: box.x ?? 0,
        top: box.y ?? 0,
        width: box.w,
        height: box.h,
        background: focus.color,
      }

  return (
    <div className={'focus-card' + (windowMode ? ' focus-card--window' : '')} style={style}>
      <div className="focus-head" onPointerDown={windowMode ? undefined : (e) => onPointerDown(e, 'move')}>
        <span className="focus-sub">{focus.sub}</span>
        <button className="focus-x" onClick={onHide} title={windowMode ? 'Hide the focus card' : 'Hide'} onPointerDown={(e) => e.stopPropagation()}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="focus-label">{focus.label}</div>
      {focus.note ? <div className="focus-note">{focus.note}</div> : null}
      {focus.location ? <div className="focus-loc"><Icon name="mapPin" size={12} /> {focus.location}</div> : null}

      {focus.event && (
        <div className="focus-meeting">
          {focus.link && (
            <a className="focus-join" href={focus.link} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>
              <Icon name="video" size={14} /> Join
            </a>
          )}
          <button className="focus-details" onClick={onOpenEvent} onPointerDown={(e) => e.stopPropagation()}>Details</button>
        </div>
      )}

      <div className="focus-tasks">
        {!focus.tasks?.length ? (
          <div className="focus-empty">Nothing to check off right now</div>
        ) : focus.tasks.length === 1 ? (
          (() => {
            const t = focus.tasks[0]
            const done = t.status === 'completed'
            return (
              <div className="focus-single">
                <button className={'focus-complete' + (done ? ' done' : '')} onClick={() => onToggleTask(t)}>
                  <span className="check">{done && <Icon name="check" size={12} strokeWidth={2.6} />}</span>{done ? 'Completed' : 'Mark complete'}
                </button>
                {t.url && <a className="focus-open" href={t.url} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}><Icon name="externalLink" size={13} /> Open task</a>}
              </div>
            )
          })()
        ) : (
          focus.tasks.map((t) => (
            <div key={t.id} className={'focus-task' + (t.status === 'completed' ? ' done' : '')}>
              <button className="focus-task-toggle" onClick={() => onToggleTask(t)}>
                <span className="check">{t.status === 'completed' && <Icon name="check" size={12} strokeWidth={2.6} />}</span>
                <span className="ttl-col"><span className="ttl">{t.title}</span>{t.note && <span className="ttl-note">{t.note}</span>}</span>
              </button>
              {t.url && <a className="focus-task-link" href={t.url} target="_blank" rel="noreferrer" title="Open" onPointerDown={(e) => e.stopPropagation()}><Icon name="externalLink" size={13} /></a>}
            </div>
          ))
        )}
      </div>

      <div className="focus-foot">
        <span className="focus-time">{label(now)}</span>
        <button className="focus-next" onClick={onNext} onPointerDown={(e) => e.stopPropagation()}>
          Next <Icon name="chevronRight" size={15} />
        </button>
      </div>

      {!windowMode && <div className="focus-resize" onPointerDown={(e) => onPointerDown(e, 'resize')} />}
    </div>
  )
}
