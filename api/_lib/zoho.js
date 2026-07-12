// Zoho OAuth + data (CRM Deals/Leads + Projects/tasks) via plain fetch.
// Zoho is READ-ONLY here. Access tokens are minted on demand from the stored
// refresh token; api_domain (per data-center) comes back at token exchange.

function accountsDomain() {
  return process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com'
}

// accounts.zoho.<dc>  ->  projectsapi.zoho.<dc>
function projectsBase() {
  const m = accountsDomain().match(/zoho\.([a-z.]+)$/)
  const dc = m ? m[1] : 'com'
  return `https://projectsapi.zoho.${dc}`
}

export const ZOHO_SCOPES = [
  'ZohoProjects.portals.READ',
  'ZohoProjects.projects.READ',
  'ZohoProjects.tasks.READ',
  'ZohoCRM.modules.READ',
  'ZohoCRM.settings.fields.READ', // read the org's real field definitions for the filter builder
  'AaaServer.profile.READ',
]

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: ZOHO_SCOPES.join(','),
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${accountsDomain()}/oauth/v2/auth?${p.toString()}`
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(`${accountsDomain()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(`zoho token exchange: ${data.error || res.status}`)
  return data // { access_token, refresh_token, api_domain, expires_in }
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const res = await fetch(`${accountsDomain()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(`zoho token refresh: ${data.error || res.status}`)
  return { accessToken: data.access_token, apiDomain: data.api_domain }
}

export async function getProfile(accessToken) {
  try {
    const res = await fetch(`${accountsDomain()}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    })
    const d = await res.json()
    return { email: d.Email || null, name: d.Display_Name || null }
  } catch {
    return { email: null, name: null }
  }
}

// --- CRM (Deals / Leads) ----------------------------------------------------

async function crmGet(apiDomain, accessToken, module, fields) {
  const url = `${apiDomain}/crm/v8/${module}?fields=${encodeURIComponent(fields)}&per_page=200`
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } })
  if (res.status === 204) return []
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`zoho crm ${module}: ${data.message || JSON.stringify(data)}`)
  return data.data || []
}

// A deal/lead is "closed" if its stage/status reads as won, lost, closed,
// dead, cancelled, junk or converted. Used only to pick sensible DEFAULTS —
// the user can override which stages/values show in the Customize panel.
const CLOSED_DEAL = /clos|won|lost|dead|cancel|junk|complet/i
const CLOSED_LEAD = /lost|junk|convert|dead|not\s*qualif/i

// Read one CRM field value to a plain string (lookups -> name, multiselect -> joined).
function fieldVal(v) {
  if (v == null) return null
  if (Array.isArray(v)) return v.map(fieldVal).filter(Boolean).join(', ') || null
  if (typeof v === 'object') return v.name || v.display_value || null
  return String(v)
}

// Field types the user can pick a value from (enumerable). Everything else
// (free text, numbers, dates, textarea) isn't offered as a select-a-value filter.
const FILTER_TYPES = new Set(['picklist', 'multiselectpicklist', 'lookup', 'ownerlookup', 'boolean'])

// Real filterable fields for a module, straight from the org's field metadata.
// Each carries its picklist values (when it has them). Requires the
// ZohoCRM.settings.fields.READ scope; returns [] if unavailable.
export async function listCrmFields(apiDomain, accessToken, module) {
  try {
    const url = `${apiDomain}/crm/v8/settings/fields?module=${module}&type=all`
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } })
    if (!res.ok) return []
    const data = await res.json().catch(() => ({}))
    const out = []
    for (const f of data.fields || []) {
      if (!FILTER_TYPES.has(f.data_type)) continue
      out.push({ api_name: f.api_name, label: f.field_label || f.api_name, values: (f.pick_list_values || []).map((v) => v.display_value).filter(Boolean) })
    }
    return out.slice(0, 45)
  } catch { return [] }
}

// Fetch records with every requested field, tagging each with a { fields } map
// and an `open` default flag. No hard server-side filter — the panel decides.
async function listCrmRecords(apiDomain, accessToken, module, titleOf, subOf, closedRe, fieldNames) {
  const base = module === 'Deals' ? ['Deal_Name', 'Stage', 'Amount', 'Account_Name'] : ['Full_Name', 'Last_Name', 'Company', 'Lead_Status']
  const all = [...new Set([...base, 'Owner', ...fieldNames])].slice(0, 50).join(',')
  const rows = await crmGet(apiDomain, accessToken, module, all)
  const statusField = module === 'Deals' ? 'Stage' : 'Lead_Status'
  return rows.map((r) => {
    const fields = {}
    for (const n of new Set(['Owner', statusField, ...fieldNames])) fields[n] = fieldVal(r[n])
    return {
      id: String(r.id),
      title: titleOf(r),
      sub: subOf(r),
      open: !closedRe.test(r[statusField] || ''),
      fields,
    }
  })
}

export async function listOpenDeals(apiDomain, accessToken, fieldNames = []) {
  return listCrmRecords(
    apiDomain, accessToken, 'Deals',
    (r) => r.Deal_Name || 'Deal',
    (r) => [r.Account_Name?.name, r.Stage, r.Amount ? `$${r.Amount}` : ''].filter(Boolean).join(' · '),
    CLOSED_DEAL, fieldNames,
  )
}

export async function listOpenLeads(apiDomain, accessToken, fieldNames = []) {
  return listCrmRecords(
    apiDomain, accessToken, 'Leads',
    (r) => r.Full_Name || r.Last_Name || 'Lead',
    (r) => [r.Company, r.Lead_Status].filter(Boolean).join(' · '),
    CLOSED_LEAD, fieldNames,
  )
}

// --- Projects (portals -> projects -> tasks) --------------------------------

async function projGet(path, accessToken) {
  const res = await fetch(`${projectsBase()}/restapi${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`zoho projects ${path}: ${data.error?.message || JSON.stringify(data)}`)
  return data
}

// Zoho migrated Projects to the V3 API (/api/v3 replaces /restapi). Tasks now
// live only on V3, so those calls go through here.
async function projGetV3(path, accessToken) {
  const res = await fetch(`${projectsBase()}/api/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`zoho projects v3 ${path}: ${data.error?.message || data.message || JSON.stringify(data).slice(0, 140)}`)
  return data
}

// V3 returns large ids as `id_string` to survive JSON number precision; prefer it.
const zid = (o) => String(o.id_string || o.id)

export async function listPortals(accessToken) {
  // Use V3 so portal ids match the V3 tasks endpoint; fall back to classic.
  try {
    const d = await projGetV3('/portals', accessToken)
    const arr = d.portals || d.data || []
    if (arr.length) return arr.map((p) => ({ id: zid(p), name: p.name || p.portal_name || 'Portal' }))
  } catch { /* fall through */ }
  const d = await projGet('/portals/', accessToken)
  return (d.portals || []).map((p) => ({ id: String(p.id), name: p.name }))
}

export async function listProjects(portalId, accessToken) {
  try {
    const d = await projGetV3(`/portal/${portalId}/projects?per_page=200`, accessToken)
    const arr = d.projects || d.data || []
    return arr.map((p) => ({ id: zid(p), name: p.name || 'Project' }))
  } catch {
    const d = await projGet(`/portal/${portalId}/projects/`, accessToken)
    return (d.projects || []).map((p) => ({ id: String(p.id), name: p.name }))
  }
}

const closedName = (t) => {
  const s = t.status
  return s?.name || s?.type || (typeof s === 'string' ? s : '') || t.status_name || ''
}

// Normalize one V3 task to our shape, carrying its project ref for grouping.
function mapProjectTask(t) {
  const ownerList = t.details?.owners || t.owners || t.assignees || (t.owner ? [t.owner] : []) || (t.assignee ? [t.assignee] : [])
  const owners = (Array.isArray(ownerList) ? ownerList : []).map((o) => o?.name || o?.full_name || o?.first_name || o?.zpuid || o).filter((x) => x && typeof x === 'string')
  const status = closedName(t) || null
  const priority = (typeof t.priority === 'object' ? t.priority?.name : t.priority) || t.priority_name || null
  const tasklist = t.tasklist?.name || t.tasklist_name || null
  const fields = {}
  if (status) fields.Status = status
  if (priority) fields.Priority = priority
  if (owners.length) fields.Owner = owners.join(', ')
  if (tasklist) fields['Task List'] = tasklist
  if (t.percent_complete != null && t.percent_complete !== '') fields['% Complete'] = String(t.percent_complete)
  const raw = t.custom_fields || t.customfields || t.custom_field_values || []
  if (Array.isArray(raw)) {
    for (const c of raw) {
      const key = c.label_name || c.column_name || c.label || c.name
      const val = c.value != null ? c.value : c.field_value
      if (key && val != null && val !== '') fields[key] = String(val)
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw)) if (val != null && val !== '') fields[key] = String(val)
  }
  const proj = t.project || t.project_details || {}
  return {
    id: zid(t), title: t.name, status: 'needsAction', owners, fields,
    projectId: String(proj.id_string || proj.id || t.project_id || t.projectId || 'all'),
    projectName: proj.name || t.project_name || 'Tasks',
  }
}

// Get every open task in a portal in one call (V3), each tagged with its
// project — far more robust than per-project calls (no project-id round-trips).
export async function listPortalTasks(portalId, accessToken) {
  const out = []
  for (let page = 1; page <= 10; page++) {
    const d = await projGetV3(`/portal/${portalId}/tasks?per_page=200&page=${page}`, accessToken)
    const arr = d.tasks || d.data || []
    for (const t of arr) if (!/closed|completed/i.test(closedName(t))) out.push(mapProjectTask(t))
    if (!(d.page_info?.has_next_page) || !arr.length) break
  }
  return out
}

// Kept for compatibility: tasks in one project (V3).
export async function listProjectTasks(portalId, projectId, accessToken) {
  const d = await projGetV3(`/portal/${portalId}/projects/${projectId}/tasks?per_page=200`, accessToken)
  return (d.tasks || d.data || [])
    .filter((t) => !/closed|completed/i.test(closedName(t)))
    .map((t) => {
      const m = mapProjectTask(t)
      return { id: m.id, title: m.title, status: 'needsAction', owners: m.owners, fields: m.fields }
    })
}

// Task ids assigned to the authenticated user in a portal (Zoho's own "My Tasks").
// Returns null if the endpoint can't be reached, so callers can fall back gracefully.
export async function listMyTaskIds(portalId, accessToken) {
  try {
    const d = await projGetV3(`/portal/${portalId}/mytasks?per_page=200`, accessToken)
    return new Set((d.tasks || d.data || []).map((t) => zid(t)))
  } catch {
    return null // fall back to owner-name matching
  }
}
