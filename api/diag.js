// Temporary storage diagnostic. Visit /api/diag to see where data lives
// (Redis vs Blob) and whether the migration recovered it. Exposes counts and
// flags only — never tokens or actual content. Remove once storage is verified.
import { diagnostics } from './_lib/store.js'

export default async function handler(req, res) {
  try {
    const d = await diagnostics()
    res.setHeader('content-type', 'application/json')
    return res.status(200).send(JSON.stringify({ build: 'diag-v1', ...d }, null, 2))
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
