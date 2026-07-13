// Zoho data (READ-ONLY). POST { action: "fetch" } ->
//   { crm: { deals[], leads[] }, projects: [{ id, name, tasks[] }], errors[] }
import { requireUser, listConnections, getConnection } from '../_lib/store.js'
import {
  refreshAccessToken, getProfile, listCrmFields, listOpenDeals, listOpenLeads, listPortals, listPortalTasks, listMyTaskIds,
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
    const crm = { deals: [], leads: [], dealFields: [], leadFields: [] }
    const projects = []
    const statusOptions = new Set() // all project task statuses (incl. closed)
    const errors = []

    for (const c of zohoConns) {
      let accessToken, apiDomain
      try {
        // getConnection decrypts the refresh token; if that throws (e.g. a
        // rotated SESSION_SECRET) degrade this account instead of 500ing all.
        const full = await getConnection(c.id)
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

      // CRM — deals & leads (each source isolated so one failure doesn't sink the rest).
      // Field metadata drives the "choose a field to filter by" panel; records carry
      // every filterable field so the client can filter by any of them.
      let dealFields = [], leadFields = []
      try { dealFields = await listCrmFields(apiDomain, accessToken, 'Deals'); crm.dealFields = dealFields } catch {}
      try { leadFields = await listCrmFields(apiDomain, accessToken, 'Leads'); crm.leadFields = leadFields } catch {}
      try { crm.deals.push(...(await listOpenDeals(apiDomain, accessToken, dealFields.map((f) => f.api_name)))) } catch (e) { errors.push(`deals: ${e.message || e}`) }
      try { crm.leads.push(...(await listOpenLeads(apiDomain, accessToken, leadFields.map((f) => f.api_name)))) } catch (e) { errors.push(`leads: ${e.message || e}`) }

      // Projects — one portal-level tasks call per portal (V3), grouped by project.
      try {
        const portals = await listPortals(accessToken)
        const meName = (profile.name || '').trim().toLowerCase()
        for (const portal of portals) {
          const myIds = await listMyTaskIds(portal.id, accessToken) // Set | null
          let tasks = []
          try {
            const r = await listPortalTasks(portal.id, accessToken)
            tasks = r.tasks
            for (const s of r.statuses || []) statusOptions.add(s)
          } catch (e) {
            errors.push(`tasks: ${e.message || e}`)
            continue
          }
          const byProject = new Map()
          for (const t of tasks) {
            const mine = myIds ? myIds.has(t.id) : (meName && t.owners?.length ? t.owners.some((o) => o.trim().toLowerCase() === meName) : null)
            if (!byProject.has(t.projectId)) byProject.set(t.projectId, { id: t.projectId, name: t.projectName, portalId: portal.id, tasks: [] })
            byProject.get(t.projectId).tasks.push({ id: t.id, title: t.title, status: t.status, owners: t.owners, fields: t.fields, url: t.url, mine })
          }
          for (const proj of byProject.values()) projects.push(proj)
        }
      } catch (e) {
        errors.push(`projects: ${e.message || e}`)
      }
    }

    return res.status(200).json({ crm, projects, projectFieldOptions: { Status: [...statusOptions] }, errors })
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) })
  }
}
