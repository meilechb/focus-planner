// Storage + auth + secret-at-rest for Focus Planner.
//
// All app data lives in a single Upstash Redis hash (`focus:doc`). Each piece
// of state is its own hash field, so a write updates exactly one field
// atomically (HSET) — two saves to different fields can't clobber each other.
// Connections are one field holding an array; their refresh tokens are
// encrypted at rest with AES-256-GCM. Single user, so last-write-wins per
// field. @upstash/redis serializes JSON automatically (HSET stores objects as
// JSON, HGETALL returns them parsed).

import crypto from 'node:crypto'
import { Redis } from '@upstash/redis'

// The app document is a Redis hash. LEGACY_KEY is the previous whole-doc string
// key; we seed the hash from it once so nothing already stored is lost.
const HASH_KEY = 'focus:doc'
const LEGACY_KEY = 'focus:data'

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
  if (!url || !token) {
    throw new Error('Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_* equivalents) in your Vercel project.')
  }
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

export const STATE_KEYS = new Set([
  'timezone',
  'projects',
  'blocks',
  'favorites',
  'selectedCalendars',
  'selectedTaskLists',
  'selectedZoho',
])

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
// Read / write (Redis hash: one field per state key + a `connections` field)
// ---------------------------------------------------------------------------

// One-time seed: if the hash is empty but the old whole-doc string key holds a
// value, copy it into the hash so pre-existing data isn't stranded.
async function seedFromLegacy() {
  let legacy
  try { legacy = await redis().get(LEGACY_KEY) } catch { return null }
  if (!legacy || typeof legacy !== 'object') return null
  const state = { ...DEFAULT_STATE, ...(legacy.state || {}) }
  const connections = Array.isArray(legacy.connections) ? legacy.connections : []
  const fields = {}
  for (const k of STATE_KEYS) fields[k] = state[k]
  fields.connections = connections
  try { await redis().hset(HASH_KEY, fields) } catch {}
  return { state, connections }
}

// The whole document: { state, connections }.
async function readAll() {
  const h = await redis().hgetall(HASH_KEY)
  if (!h || Object.keys(h).length === 0) {
    const seeded = await seedFromLegacy()
    if (seeded) return seeded
    return { state: { ...DEFAULT_STATE }, connections: [] }
  }
  const state = { ...DEFAULT_STATE }
  for (const k of STATE_KEYS) if (h[k] !== undefined && h[k] !== null) state[k] = h[k]
  const connections = Array.isArray(h.connections) ? h.connections : []
  return { state, connections }
}

async function readConnections() {
  const c = await redis().hget(HASH_KEY, 'connections')
  return Array.isArray(c) ? c : []
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

// Public state = everything the browser is allowed to see (no secrets).
export async function getPublicState() {
  const { state } = await readAll()
  return state
}

// Write exactly one state field, atomically.
export async function writeStateKey(key, value) {
  if (!STATE_KEYS.has(key)) throw new Error('invalid state key: ' + key)
  await redis().hset(HASH_KEY, { [key]: value })
}

// ---------------------------------------------------------------------------
// Connections (secrets stripped / encrypted)
// ---------------------------------------------------------------------------

function publicConnection(c) {
  const { refresh_token, ...rest } = c
  return rest
}

export async function listConnections() {
  const conns = await readConnections()
  return conns.map(publicConnection)
}

// Full connection incl. DECRYPTED refresh token — server-side only.
export async function getConnection(id) {
  const conns = await readConnections()
  const c = conns.find((x) => x.id === id)
  if (!c) return null
  return { ...c, refresh_token: decryptSecret(c.refresh_token) }
}

// Upsert on (provider, account_email). Encrypts the refresh token at rest.
export async function saveConnection(conn) {
  const connections = await readConnections()
  const stored = { ...conn, refresh_token: encryptSecret(conn.refresh_token) }
  // Upsert only when we have a real email to match on; otherwise (email lookup
  // failed) always insert as a distinct connection so two unknown accounts
  // don't collide on (provider, null) and overwrite each other.
  const idx = conn.account_email
    ? connections.findIndex((x) => x.provider === conn.provider && x.account_email === conn.account_email)
    : -1
  if (idx >= 0) {
    stored.id = connections[idx].id // keep stable id
    connections[idx] = stored
  } else {
    stored.id = conn.id || crypto.randomUUID()
    connections.push(stored)
  }
  await redis().hset(HASH_KEY, { connections })
  return publicConnection(stored)
}

export async function deleteConnection(id) {
  const connections = (await readConnections()).filter((x) => x.id !== id)
  await redis().hset(HASH_KEY, { connections })
}

// ---------------------------------------------------------------------------
// Health check (counts and flags only — never tokens or content)
// ---------------------------------------------------------------------------

export async function diagnostics() {
  const out = { store: 'redis-hash', redisConfigured: redisConfigured() }
  try {
    const { state, connections } = await readAll()
    const blocks = state.blocks || {}
    out.ok = true
    out.data = {
      blockDays: Object.keys(blocks).length,
      totalBlocks: Object.values(blocks).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0),
      projects: Array.isArray(state.projects) ? state.projects.length : 0,
      favorites: Array.isArray(state.favorites) ? state.favorites.length : 0,
      connections: connections.map((c) => ({ provider: c.provider, email: c.account_email || null, hasToken: !!c.refresh_token })),
    }
  } catch (e) {
    out.ok = false
    out.error = String(e.message || e)
  }
  return out
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
