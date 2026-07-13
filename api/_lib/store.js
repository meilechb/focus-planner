// Storage + auth + secret-at-rest for Focus Planner.
//
// The entire app is a single JSON document. It lives under one key in Upstash
// Redis (serverless-native KV, generous free tier) when Redis is configured —
// read = one GET, write = one SET, no per-write operation churn. If Redis is
// NOT configured, it transparently falls back to the legacy Vercel Blob store
// so the app keeps working during the switch-over. The first time a
// Redis-backed read finds nothing, it copies the existing Blob document over
// (a one-time migration), so no data — including connected accounts — is lost.
// Refresh tokens inside the doc are encrypted at rest with AES-256-GCM. Single
// user, so last-write-wins.

import crypto from 'node:crypto'
import { Redis } from '@upstash/redis'
import { list, put, del } from '@vercel/blob'

// The whole app document lives under this one Redis key.
const DOC_KEY = 'focus:data'
// Legacy Vercel Blob prefix (fallback backend + one-time migration source).
const BLOB_PREFIX = 'focus/data'

function redisConfigured() {
  return !!(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)
  )
}

// Lazily build the Redis client from env. Supports both the Upstash-native
// variable names and Vercel's KV integration names, so whichever way the store
// is connected in the Vercel dashboard works without code changes.
let _redis = null
function redis() {
  if (_redis) return _redis
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  _redis = new Redis({ url, token })
  return _redis
}

export const DEFAULT_STATE = {
  timezone: 'America/New_York',
  projects: [],
  blocks: {},
  favorites: [],
  selectedCalendars: [],
  selectedTaskLists: [],
  selectedZoho: [],
}

function emptyDoc() {
  return { state: { ...DEFAULT_STATE }, connections: [] }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function secret() {
  const s = process.env.SESSION_SECRET
  if (!s) throw new Error('SESSION_SECRET is not set')
  return s
}

function aesKey() {
  // Derive a stable 32-byte key from SESSION_SECRET.
  return crypto.createHash('sha256').update('focus-aes|' + secret()).digest()
}

const ENC_PREFIX = 'enc:v1:'

export function encryptSecret(plain) {
  if (plain == null) return plain
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptSecret(value) {
  if (value == null) return value
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value // tolerate legacy plaintext
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ct = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Read / write (single JSON doc, last-write-wins). Redis when configured,
// legacy Vercel Blob otherwise, with a one-time Blob→Redis migration.
// ---------------------------------------------------------------------------

function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return null
  if (!doc.state) doc.state = { ...DEFAULT_STATE }
  if (!Array.isArray(doc.connections)) doc.connections = []
  return doc
}

// Newest Blob version (immutable URL, always fresh). Returns null if there are
// no versions yet; throws on an actual fetch/parse failure so a write never
// runs against wrongly-empty data.
async function blobReadNewest() {
  const r = await list({ prefix: BLOB_PREFIX })
  const blobs = (r.blobs || []).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
  if (!blobs.length) return null
  const res = await fetch(blobs[0].url)
  if (!res.ok) throw new Error(`blob read failed: ${res.status}`)
  const doc = normalizeDoc(JSON.parse(await res.text()))
  if (!doc) throw new Error('blob parse failed')
  return doc
}

async function blobWrite(doc) {
  const written = await put(`${BLOB_PREFIX}.json`, JSON.stringify(doc), {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'application/json',
  })
  // Delete only versions older than the one we just wrote (never a concurrent
  // writer's newer version).
  try {
    const r = await list({ prefix: BLOB_PREFIX })
    const blobs = (r.blobs || []).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    const idx = blobs.findIndex((b) => b.url === written.url)
    if (idx !== -1) {
      const stale = blobs.slice(idx + 1).map((b) => b.url)
      if (stale.length) await del(stale)
    }
  } catch {}
}

async function readDoc() {
  if (redisConfigured()) {
    // @upstash/redis auto-serializes JSON: get() returns the parsed object (or
    // null when the key doesn't exist yet).
    const doc = normalizeDoc(await redis().get(DOC_KEY))
    if (doc) return { doc }
    // Redis is empty — one-time migration: pull the existing Blob document (if
    // any) and seed Redis with it, so blocks, settings AND connected accounts
    // carry over without anyone having to reconnect.
    try {
      const legacy = await blobReadNewest()
      if (legacy) {
        try { await redis().set(DOC_KEY, legacy) } catch {}
        return { doc: legacy }
      }
    } catch {}
    return { doc: emptyDoc(), empty: true }
  }
  // Redis not configured yet — keep working off the legacy Blob store.
  const doc = await blobReadNewest()
  if (!doc) return { doc: emptyDoc(), empty: true }
  return { doc }
}

// Read the whole doc (for GET /api/data). Refresh tokens are NOT decrypted here.
export async function loadDoc() {
  const { doc } = await readDoc()
  return doc
}

// Read, apply `mutator`, write the whole doc back. Single-user app, so
// last-write-wins is fine.
async function mutateDoc(mutator) {
  const { doc } = await readDoc()
  const result = mutator(doc)
  if (redisConfigured()) await redis().set(DOC_KEY, doc)
  else await blobWrite(doc)
  return result
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

export const STATE_KEYS = new Set([
  'timezone',
  'projects',
  'blocks',
  'favorites',
  'selectedCalendars',
  'selectedTaskLists',
  'selectedZoho',
])

// Public state = everything the browser is allowed to see (no secrets).
export async function getPublicState() {
  const doc = await loadDoc()
  return doc.state
}

export async function writeStateKey(key, value) {
  if (!STATE_KEYS.has(key)) throw new Error('invalid state key: ' + key)
  return mutateDoc((doc) => {
    doc.state[key] = value
  })
}

// ---------------------------------------------------------------------------
// Connections (secrets stripped / encrypted)
// ---------------------------------------------------------------------------

function publicConnection(c) {
  const { refresh_token, ...rest } = c
  return rest
}

export async function listConnections() {
  const doc = await loadDoc()
  return doc.connections.map(publicConnection)
}

// Full connection incl. DECRYPTED refresh token — server-side only.
export async function getConnection(id) {
  const doc = await loadDoc()
  const c = doc.connections.find((x) => x.id === id)
  if (!c) return null
  return { ...c, refresh_token: decryptSecret(c.refresh_token) }
}

// Upsert on (provider, account_email). Encrypts the refresh token at rest.
export async function saveConnection(conn) {
  return mutateDoc((doc) => {
    const stored = {
      ...conn,
      refresh_token: encryptSecret(conn.refresh_token),
    }
    // Upsert only when we have a real email to match on; otherwise (email
    // lookup failed) always insert as a distinct connection so two unknown
    // accounts don't collide on (provider, null) and overwrite each other.
    const idx = conn.account_email
      ? doc.connections.findIndex((x) => x.provider === conn.provider && x.account_email === conn.account_email)
      : -1
    if (idx >= 0) {
      stored.id = doc.connections[idx].id // keep stable id
      doc.connections[idx] = stored
    } else {
      stored.id = conn.id || crypto.randomUUID()
      doc.connections.push(stored)
    }
    return publicConnection(stored)
  })
}

export async function deleteConnection(id) {
  return mutateDoc((doc) => {
    doc.connections = doc.connections.filter((x) => x.id !== id)
  })
}

// ---------------------------------------------------------------------------
// Passphrase + session
// ---------------------------------------------------------------------------

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function checkPassphrase(passphrase) {
  const expected = process.env.APP_PASSPHRASE
  if (!expected) throw new Error('APP_PASSPHRASE is not set')
  return constantTimeEqual(passphrase ?? '', expected)
}

const SESSION_DAYS = 60
const COOKIE_NAME = 'focus_session'

function hmac(input) {
  return crypto.createHmac('sha256', secret()).update(input).digest('base64url')
}

// Token = owner.<exp>.<hmac("owner.<exp>")>
export function makeSessionToken() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60
  const payload = `owner.${exp}`
  return `${payload}.${hmac(payload)}`
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [user, exp, sig] = parts
  if (user !== 'owner') return false
  const payload = `${user}.${exp}`
  const expected = hmac(payload)
  if (!constantTimeEqual(sig, expected)) return false
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false
  return true
}

export function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// Reads the session from cookie or `Authorization: Bearer` fallback.
export function readSession(req) {
  const cookies = parseCookies(req.headers?.cookie)
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME]
  const auth = req.headers?.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

export function requireUser(req) {
  // Login removed at the owner's request — the app is public, so every request
  // is allowed. Restore the check below to make it private again:
  //   const token = readSession(req); return verifySessionToken(token)
  return true
}
