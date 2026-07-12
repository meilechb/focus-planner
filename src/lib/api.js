// Thin fetch wrapper. Uses cookies (credentials:"include"); also mirrors the
// session into a Bearer header as a fallback for any cookie weirdness.

const BEARER_KEY = 'focus_bearer'

function bearer() {
  try {
    return localStorage.getItem(BEARER_KEY) || null
  } catch {
    return null
  }
}

async function req(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const b = bearer()
  if (b) headers['Authorization'] = `Bearer ${b}`
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

export const api = {
  get: (p) => req(p),
  post: (p, body) => req(p, { method: 'POST', body }),
  del: (p) => req(p, { method: 'DELETE' }),
}

// --- auth -------------------------------------------------------------------

export async function checkAuth() {
  const { authed } = await api.get('/api/login')
  return authed
}

export async function login(passphrase) {
  await api.post('/api/login', { passphrase })
  return true
}

export async function logout() {
  try {
    localStorage.removeItem(BEARER_KEY)
  } catch {}
  await api.post('/api/login?action=logout')
}
