// Session check / login / logout.
//   GET  /api/login                 -> { authed }
//   POST /api/login  { passphrase } -> sets cookie, { ok: true }
//   POST /api/login?action=logout   -> clears cookie
import {
  checkPassphrase,
  makeSessionToken,
  sessionCookie,
  clearSessionCookie,
  requireUser,
} from './_lib/store.js'

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ authed: requireUser(req) })
    }

    if (req.method === 'POST') {
      if (req.query?.action === 'logout') {
        res.setHeader('Set-Cookie', clearSessionCookie())
        return res.status(200).json({ ok: true })
      }
      const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {}
      if (!checkPassphrase(body.passphrase)) {
        return res.status(401).json({ error: 'invalid passphrase' })
      }
      res.setHeader('Set-Cookie', sessionCookie(makeSessionToken()))
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
