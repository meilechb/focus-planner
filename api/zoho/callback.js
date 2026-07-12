// Zoho OAuth callback: exchanges the code, stores the (encrypted) refresh token
// and the per-DC api_domain, and redirects back to the app.
import { saveConnection } from '../_lib/store.js'
import { verifyState } from '../_lib/state.js'
import { exchangeCode, getProfile } from '../_lib/zoho.js'

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${req.headers.host}`
}

export default async function handler(req, res) {
  const done = (status) => {
    res.writeHead(302, { Location: `/?connected=zoho&status=${status}` })
    res.end()
  }
  try {
    const { code, state } = req.query || {}
    if (!code || !verifyState(state)) return done('err')

    const clientId = process.env.ZOHO_CLIENT_ID
    const clientSecret = process.env.ZOHO_CLIENT_SECRET
    const redirectUri = `${baseUrl(req)}/api/zoho/callback`

    const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri })
    if (!tokens.refresh_token) return done('norefresh')

    const profile = await getProfile(tokens.access_token)

    await saveConnection({
      provider: 'zoho',
      account_email: profile.email,
      account_label: profile.email || profile.name || 'Zoho',
      refresh_token: tokens.refresh_token,
      extra: { api_domain: tokens.api_domain || 'https://www.zohoapis.com' },
    })
    return done('ok')
  } catch (e) {
    console.error('zoho callback error', e)
    return done('err')
  }
}
