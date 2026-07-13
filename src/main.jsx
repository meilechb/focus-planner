import React from 'react'
import { createRoot } from 'react-dom/client'
import Planner from './components/Planner.jsx'
import FocusWindow from './components/FocusWindow.jsx'
import './styles.css'

// The desktop app opens a second, always-on-top window pointed at "#focus".
// That window renders only the floating focus card; everything else is the
// full planner.
const isFocusView =
  typeof location !== 'undefined' && location.hash.replace(/^#\/?/, '').startsWith('focus')

if (isFocusView) document.body.classList.add('focus-window-body')

// Login removed at the owner's request — the app is public. Restore the auth
// gate (checkAuth -> <Login>) here, and requireUser() in api/_lib/store.js, to
// make it private again.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isFocusView ? <FocusWindow /> : <Planner />}
  </React.StrictMode>,
)
