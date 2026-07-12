import { chromium } from 'playwright-core'
const today = '2026-07-12'
const events = [
  { id: 'e1', title: 'Product sync with design team', date: today, start: 600, end: 660, link: 'https://meet.google.com/abc-defg-hij', location: 'Conference Room B', organizer: 'Sarah Chen', description: 'Review the new onboarding flow.\nAgenda:\n- Metrics\n- Q3 roadmap\nDoc: https://docs.google.com/document/d/xyz', attendees: [{ name: 'Sarah Chen', status: 'accepted', self: false }, { name: 'You', status: 'accepted', self: true }, { name: 'Mark Lee', status: 'tentative', self: false }] },
  { id: 'e2', title: '1:1 with manager', date: today, start: 840, end: 900, link: null, location: null, organizer: 'Manager', description: null, attendees: [] },
]
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
await p.route('**/api/data', (r) => r.fulfill(json({ state: { timezone: 'America/New_York', projects: [{ id: '1', name: 'Cartstrings Q3 growth marketing initiative', color: '#8E24AA', note: 'Top priority' }], blocks: {}, favorites: [
  { id: 'p:1', kind: 'project', label: 'Cartstrings Q3 growth marketing initiative', color: '#8E24AA', projectId: '1', payload: { kind: 'project', projectId: '1' } },
  { id: 'z:2', kind: 'zohoproject', label: 'Website redesign — landing pages', color: '#e42527', payload: { kind: 'batch', title: 'Website redesign', tasks: [] } },
  { id: 't:g1:l1:9', kind: 'task', label: 'Follow up with Acme about renewal contract', color: '#2563eb', payload: { kind: 'task', task: {} } },
], selectedCalendars: ['g1::primary'], selectedTaskLists: [] } })))
await p.route('**/api/connections', (r) => r.fulfill(json({ connections: [{ id: 'g1', provider: 'google', account_email: 'you@work.com' }] })))
await p.route('**/api/google/data', (r) => {
  const body = JSON.parse(r.request().postData() || '{}')
  if (body.action === 'calendars') return r.fulfill(json({ accounts: [{ connId: 'g1', email: 'you@work.com', calendars: [{ id: 'primary', summary: 'Work' }] }] }))
  if (body.action === 'taskLists') return r.fulfill(json({ accounts: [] }))
  if (body.action === 'eventsRange') return r.fulfill(json({ events }))
  if (body.action === 'tasks') return r.fulfill(json({ tasks: [] }))
  return r.fulfill(json({}))
})
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.screenshot({ path: process.argv[2] })
const ev = await p.$('.ev-meeting')
if (ev) { await ev.click(); await p.waitForTimeout(500); await p.screenshot({ path: process.argv[2].replace('.png', '-event.png') }) }
await b.close()
console.log('ok')
