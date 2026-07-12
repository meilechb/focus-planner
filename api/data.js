// Read whole app state; write one state key.
//   GET  /api/data                 -> { state }
//   POST /api/data  { key, value } -> { ok: true }  (writes exactly one key)
import { requireUser, getPublicState, writeStateKey } from './_lib/store.js'

export default async function handler(req, res) {
  try {
    if (!requireUser(req)) return res.status(401).json({ error: 'unauthorized' })

    if (req.method === 'GET') {
      const state = await getPublicState()
      return res.status(200).json({ state })
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
      const { key, value } = body
      if (!key) return res.status(400).json({ error: 'missing key' })
      await writeStateKey(key, value)
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
