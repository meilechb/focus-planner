// Temporary storage diagnostic + recovery.
//   GET /api/diag             -> where data lives (Redis vs Blob), counts only
//   GET /api/diag?restore=1   -> copy the old Blob data into Redis (recovery)
// Exposes counts and flags only — never tokens or actual content. Remove once
// storage is verified.
import { diagnostics, restoreFromBlob } from './_lib/store.js'

export default async function handler(req, res) {
  try {
    const wantsRestore = req.query?.restore === '1' || String(req.url || '').includes('restore=1')
    if (wantsRestore) {
      const r = await restoreFromBlob()
      res.setHeader('content-type', 'application/json')
      return res.status(200).send(JSON.stringify({ action: 'restore', ...r }, null, 2))
    }
    const d = await diagnostics()
    res.setHeader('content-type', 'application/json')
    return res.status(200).send(JSON.stringify({ build: 'diag-v2', ...d }, null, 2))
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
