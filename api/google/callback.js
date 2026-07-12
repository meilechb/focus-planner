// Google OAuth callback: exchanges the code, stores the (encrypted) refresh
// token, and redirects back to the app.
import { saveConnection } from '../_lib/store.js'
import { verifyState } from '../_lib/state.js'
import { exchangeCode, getUserEmail, parseFeats } from '../_lib/google.js'

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${req.headers.host}`
}

export default async function handler(req, res) {
  const done = (status) => {
    res.writeHead(302, { Location: `/?connected=google&status=${status}` })
    res.end()
  }
  try {
    const { code, state } = req.query || {}
    const st = verifyState(state)
    if (!code || !st) return done('err')
    const feats = parseFeats(Array.isArray(st.feats) ? st.feats.join(',') : st.feats)

    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    const redirectUri = `${baseUrl(req)}/api/google/callback`

    const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri })
    if (!tokens.refresh_token) {
      // Google only returns a refresh token on first consent; prompt=consent
      // forces it, but guard anyway.
      return done('norefresh')
    }
    let email = null
    try {
      email = await getUserEmail(tokens.access_token)
    } catch {}

    await saveConnection({
      provider: 'google',
      account_email: email,
      account_label: email || 'Google',
      refresh_token: tokens.refresh_token,
      extra: { features: feats },
    })
    return done('ok')
  } catch (e) {
    console.error('google callback error', e)
    return done('err')
  }
}
