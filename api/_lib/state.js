// HMAC sign/verify for the OAuth `state` param, so the callback can trust it.
import crypto from 'node:crypto'

function secret() {
  const s = process.env.SESSION_SECRET
  if (!s) throw new Error('SESSION_SECRET is not set')
  return s
}

function hmac(input) {
  return crypto.createHmac('sha256', secret()).update(input).digest('base64url')
}

// Returns an opaque, tamper-evident string encoding `payload` (an object).
export function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(body)}`
}

// Returns the decoded payload if valid & unexpired, else null.
export function verifyState(state, maxAgeSeconds = 600) {
  if (!state || typeof state !== 'string') return null
  const parts = state.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expected = hmac(body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (payload.iat && Date.now() - payload.iat > maxAgeSeconds * 1000) return null
  return payload
}
