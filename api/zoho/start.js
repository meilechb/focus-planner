// Begins Zoho OAuth: redirects the browser to Zoho's consent screen.
import { requireUser } from '../_lib/store.js'
import { signState } from '../_lib/state.js'
import { buildAuthUrl } from '../_lib/zoho.js'

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
    const clientId = process.env.ZOHO_CLIENT_ID
    if (!clientId) return res.status(500).json({ error: 'ZOHO_CLIENT_ID not set' })

    const redirectUri = `${baseUrl(req)}/api/zoho/callback`
    const state = signState({ provider: 'zoho', iat: Date.now() })
    const url = buildAuthUrl({ clientId, redirectUri, state })

    res.writeHead(302, { Location: url })
    return res.end()
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
