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

export async function listOpenDeals(apiDomain, accessToken) {
  const rows = await crmGet(apiDomain, accessToken, 'Deals', 'Deal_Name,Stage,Amount,Account_Name')
  return rows
    .filter((r) => !/closed|won|lost/i.test(r.Stage || ''))
    .map((r) => ({
      id: String(r.id),
      title: r.Deal_Name || 'Deal',
      sub: [r.Account_Name?.name, r.Stage, r.Amount ? `$${r.Amount}` : ''].filter(Boolean).join(' · '),
    }))
}

export async function listOpenLeads(apiDomain, accessToken) {
  const rows = await crmGet(apiDomain, accessToken, 'Leads', 'Full_Name,Last_Name,Company,Lead_Status')
  return rows
    .filter((r) => !/lost|junk|converted/i.test(r.Lead_Status || ''))
    .map((r) => ({
      id: String(r.id),
      title: r.Full_Name || r.Last_Name || 'Lead',
      sub: [r.Company, r.Lead_Status].filter(Boolean).join(' · '),
    }))
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

export async function listPortals(accessToken) {
  const d = await projGet('/portals/', accessToken)
  return (d.portals || []).map((p) => ({ id: String(p.id), name: p.name }))
}

export async function listProjects(portalId, accessToken) {
  const d = await projGet(`/portal/${portalId}/projects/`, accessToken)
  return (d.projects || []).map((p) => ({ id: String(p.id), name: p.name }))
}

export async function listProjectTasks(portalId, projectId, accessToken) {
  const d = await projGet(`/portal/${portalId}/projects/${projectId}/tasks/`, accessToken)
  return (d.tasks || [])
    .filter((t) => !(t.status && /closed/i.test(t.status.type || t.status.name || '')))
    .map((t) => ({ id: String(t.id), title: t.name, status: 'needsAction' }))
}
