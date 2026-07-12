// Storage + auth + secret-at-rest for Focus Planner.
//
// The entire app is a single JSON document in a Vercel Blob store (standard
// "public" access — private access returned 400 on this store, and it works on
// every plan). The blob's URL is not exposed by any endpoint, and refresh
// tokens inside the doc are still encrypted at rest with AES-256-GCM, so a
// leaked blob yields no usable secrets. Reads bypass the CDN cache (unique
// query param) for read-after-write freshness. Writes use optimistic
// concurrency (ETag ifMatch) with a bounded retry so overlapping invocations
// cannot silently clobber each other.

import crypto from 'node:crypto'
import { head, put, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob'

const BLOB_PATH = 'focus/data.json'
const WRITE_RETRIES = 4

export const DEFAULT_STATE = {
  timezone: 'America/New_York',
  projects: [],
  blocks: {},
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
// Blob read / write (private store, optimistic concurrency)
// ---------------------------------------------------------------------------

async function readDoc() {
  let meta
  try {
    meta = await head(BLOB_PATH)
  } catch (e) {
    // First run: the doc doesn't exist yet.
    if (e instanceof BlobNotFoundError || /not.?found/i.test(e?.message || '')) {
      return { doc: emptyDoc(), etag: null }
    }
    throw e
  }
  // Fetch the content fresh, bypassing the CDN cache with a unique query param.
  const res = await fetch(`${meta.url}?ts=${Date.now()}`, { cache: 'no-store' })
  if (res.status === 404) return { doc: emptyDoc(), etag: null }
  if (!res.ok) throw new Error(`blob read failed: ${res.status}`)
  const text = await res.text()
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    doc = emptyDoc()
  }
  if (!doc.state) doc.state = { ...DEFAULT_STATE }
  if (!Array.isArray(doc.connections)) doc.connections = []
  return { doc, etag: meta.etag ?? null }
}

async function writeDoc(doc, etag) {
  await put(BLOB_PATH, JSON.stringify(doc), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    ...(etag ? { ifMatch: etag } : {}),
  })
}

// Read the whole doc (for GET /api/data). Refresh tokens are NOT decrypted here.
export async function loadDoc() {
  const { doc } = await readDoc()
  return doc
}

// Apply `mutator(doc)` and persist, retrying on concurrent modification.
async function mutateDoc(mutator) {
  let lastErr
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    const { doc, etag } = await readDoc()
    const result = mutator(doc)
    try {
      await writeDoc(doc, etag)
      return result
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) {
        lastErr = e
        continue // someone else wrote between our read and write; re-read and retry
      }
      throw e
    }
  }
  throw lastErr || new Error('write failed after retries')
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

const STATE_KEYS = new Set([
  'timezone',
  'projects',
  'blocks',
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
    const idx = doc.connections.findIndex(
      (x) => x.provider === conn.provider && x.account_email === conn.account_email,
    )
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
