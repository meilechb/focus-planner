import React, { useState } from 'react'
import { login } from '../lib/api.js'

export default function Login({ onDone }) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(passphrase)
      onDone()
    } catch (err) {
      setError(err.status === 401 ? 'Wrong passphrase.' : err.message || 'Login failed.')
      setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><span className="dot" /> Focus Planner</div>
        <div className="login-sub">Enter your passphrase to continue</div>
        <input
          className="underline-input"
          type="password"
          value={passphrase}
          autoFocus
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase"
        />
        {error && <div className="login-error">{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy || !passphrase}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  )
}
