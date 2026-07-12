import React from 'react'
import { createRoot } from 'react-dom/client'
import Planner from './components/Planner.jsx'
import './styles.css'

// Login removed at the owner's request — the app is public. Restore the auth
// gate (checkAuth -> <Login>) here, and requireUser() in api/_lib/store.js, to
// make it private again.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Planner />
  </React.StrictMode>,
)
