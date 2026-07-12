// List connected accounts (secrets stripped); remove one.
//   GET    /api/connections        -> { connections: [...] }   (no refresh tokens)
//   DELETE /api/connections?id=... -> { ok: true }
import { requireUser, listConnections, deleteConnection } from './_lib/store.js'

export default async function handler(req, res) {
  try {
    if (!requireUser(req)) return res.status(401).json({ error: 'unauthorized' })

    if (req.method === 'GET') {
      const connections = await listConnections()
      return res.status(200).json({ connections })
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id
      if (!id) return res.status(400).json({ error: 'missing id' })
      await deleteConnection(id)
      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', 'GET, DELETE')
    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
