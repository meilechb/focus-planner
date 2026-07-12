import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { checkAuth } from './lib/api.js'
import Login from './components/Login.jsx'
import Planner from './components/Planner.jsx'
import './styles.css'

function App() {
  const [status, setStatus] = useState('loading') // loading | out | in

  useEffect(() => {
    let alive = true
    checkAuth()
      .then((authed) => alive && setStatus(authed ? 'in' : 'out'))
      .catch(() => alive && setStatus('out'))
    return () => {
      alive = false
    }
  }, [])

  if (status === 'loading') {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    )
  }
  if (status === 'out') return <Login onDone={() => setStatus('in')} />
  return <Planner onLoggedOut={() => setStatus('out')} />
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
