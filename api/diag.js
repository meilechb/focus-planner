// Storage health check. Visit /api/diag to confirm Redis is connected and see
// how much data is stored (counts and flags only — never tokens or content).
import { diagnostics } from './_lib/store.js'

export default async function handler(req, res) {
  try {
    const d = await diagnostics()
    res.setHeader('content-type', 'application/json')
    return res.status(200).send(JSON.stringify({ build: 'diag-v3', ...d }, null, 2))
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
