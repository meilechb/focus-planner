// Begins Google OAuth: redirects the browser to Google's consent screen.
import { requireUser } from '../_lib/store.js'
import { signState } from '../_lib/state.js'
import { buildAuthUrl, parseFeats } from '../_lib/google.js'

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${req.headers.host}`
}

export default async function handler(req, res) {
  try {
    if (!requireUser(req)) {
      res.writeHead(302, { Location: '/' })
      return res.end()
    }
    const clientId = process.env.GOOGLE_CLIENT_ID
    if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not set' })

    const feats = parseFeats(req.query?.feats)
    const redirectUri = `${baseUrl(req)}/api/google/callback`
    const state = signState({ provider: 'google', feats, iat: Date.now() })
    const url = buildAuthUrl({ clientId, redirectUri, state, feats })

    res.writeHead(302, { Location: url })
    return res.end()
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
