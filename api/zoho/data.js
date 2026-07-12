// Zoho data (READ-ONLY). POST { action: "fetch" } ->
//   { crm: { deals[], leads[] }, projects: [{ id, name, tasks[] }], errors[] }
import { requireUser, listConnections, getConnection } from '../_lib/store.js'
import {
  refreshAccessToken, getProfile, listOpenDeals, listOpenLeads, listPortals, listProjects, listProjectTasks, listMyTaskIds,
} from '../_lib/zoho.js'

const clientId = () => process.env.ZOHO_CLIENT_ID
const clientSecret = () => process.env.ZOHO_CLIENT_SECRET

export default async function handler(req, res) {
  try {
    if (!requireUser(req)) return res.status(401).json({ error: 'unauthorized' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'method not allowed' })
    }

    const zohoConns = (await listConnections()).filter((c) => c.provider === 'zoho')
    const crm = { deals: [], leads: [] }
    const projects = []
    const errors = []

    for (const c of zohoConns) {
      const full = await getConnection(c.id)
      let accessToken, apiDomain
      try {
        const r = await refreshAccessToken({
          refreshToken: full.refresh_token,
          clientId: clientId(),
          clientSecret: clientSecret(),
        })
        accessToken = r.accessToken
        apiDomain = r.apiDomain || full.extra?.api_domain || 'https://www.zohoapis.com'
      } catch (e) {
        errors.push(`auth: ${e.message || e}`)
        continue
      }

      const profile = await getProfile(accessToken) // { email, name } for ownership matching

      // CRM — deals & leads (each source isolated so one failure doesn't sink the rest)
      try { crm.deals.push(...(await listOpenDeals(apiDomain, accessToken))) } catch (e) { errors.push(`deals: ${e.message || e}`) }
      try { crm.leads.push(...(await listOpenLeads(apiDomain, accessToken))) } catch (e) { errors.push(`leads: ${e.message || e}`) }

      // Projects — portals -> projects -> tasks
      try {
        const portals = await listPortals(accessToken)
        for (const portal of portals) {
          const myIds = await listMyTaskIds(portal.id, accessToken) // Set | null
          const projs = await listProjects(portal.id, accessToken)
          for (const p of projs) {
            let tasks = []
            try {
              tasks = await listProjectTasks(portal.id, p.id, accessToken)
            } catch (e) {
              errors.push(`tasks(${p.name}): ${e.message || e}`)
            }
            // Mark ownership: prefer Zoho's My Tasks set; fall back to owner-name
            // match against the profile; null when we simply can't tell.
            const meName = (profile.name || '').trim().toLowerCase()
            tasks = tasks.map((t) => {
              let mine = null
              if (myIds) mine = myIds.has(t.id)
              else if (meName && t.owners?.length) mine = t.owners.some((o) => o.trim().toLowerCase() === meName)
              return { ...t, mine }
            })
            projects.push({ id: p.id, name: p.name, portalId: portal.id, tasks })
          }
        }
      } catch (e) {
        errors.push(`projects: ${e.message || e}`)
      }
    }

    return res.status(200).json({ crm, projects, errors })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
