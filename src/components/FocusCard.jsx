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

export default function FocusCard({ focus, now, onToggleTask, onNext, onHide }) {
  const [box, setBox] = useState(loadBox)
  const drag = useRef(null)

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(box))
    } catch {}
  }, [box])

  // default to bottom-right on first render if never positioned
  useEffect(() => {
    if (box.x == null || box.y == null) {
      setBox((b) => ({
        ...b,
        x: window.innerWidth - b.w - 24,
        y: window.innerHeight - b.h - 24,
      }))
    }
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
  }

  const style = {
    left: box.x ?? 0,
    top: box.y ?? 0,
    width: box.w,
    height: box.h,
    background: focus.color,
  }

  return (
    <div className="focus-card" style={style}>
      <div className="focus-head" onPointerDown={(e) => onPointerDown(e, 'move')}>
        <span className="focus-sub">{focus.sub}</span>
        <button className="focus-x" onClick={onHide} title="Hide" onPointerDown={(e) => e.stopPropagation()}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="focus-label">{focus.label}</div>
      {focus.note ? <div className="focus-note">{focus.note}</div> : null}

      <div className="focus-tasks">
        {!focus.tasks?.length ? (
          <div className="focus-empty">Nothing to check off right now</div>
        ) : focus.tasks.length === 1 ? (
          (() => {
            const t = focus.tasks[0]
            const done = t.status === 'completed'
            return (
              <button className={'focus-complete' + (done ? ' done' : '')} onClick={() => onToggleTask(t)}>
                <span className="check">{done && <Icon name="check" size={12} strokeWidth={2.6} />}</span>{done ? 'Completed' : 'Mark complete'}
              </button>
            )
          })()
        ) : (
          focus.tasks.map((t) => (
            <button key={t.id} className={'focus-task' + (t.status === 'completed' ? ' done' : '')} onClick={() => onToggleTask(t)}>
              <span className="check">{t.status === 'completed' && <Icon name="check" size={12} strokeWidth={2.6} />}</span>
              <span className="ttl">{t.title}</span>
            </button>
          ))
        )}
      </div>

      <div className="focus-foot">
        <span className="focus-time">{label(now)}</span>
        <button className="focus-next" onClick={onNext} onPointerDown={(e) => e.stopPropagation()}>
          Next <Icon name="chevronRight" size={15} />
        </button>
      </div>

      <div className="focus-resize" onPointerDown={(e) => onPointerDown(e, 'resize')} />
    </div>
  )
}
