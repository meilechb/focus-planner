import { chromium } from 'playwright-core'
const today = '2026-07-12'
const OUT = '/tmp/claude-0/-home-user-focus-planner/ab725534-a039-5ccc-8245-4d8d1a6531a1/scratchpad/'
const mkEvents = (d) => ([
  { id: d+'e1', title: 'Product sync with design team', date: d, start: 600, end: 660, link: 'https://meet.google.com/abc', location: 'Room B', organizer: 'Sarah Chen', description: 'Review onboarding.', attendees: [{ name: 'Sarah', status: 'accepted' }, { name: 'You', status: 'accepted', self: true }] },
  { id: d+'e2', title: 'Sales standup', date: d, start: 540, end: 570, link: null, attendees: [] },
  { id: d+'e3', title: 'Client call — Acme renewal', date: d, start: 780, end: 840, link: 'https://zoom.us/j/123', attendees: [] },
])
const dates = ['2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-12']
const events = dates.flatMap(mkEvents)
const gtasks = [
  { id: 't1', title: 'Follow up with Acme about the renewal contract terms', status: 'needsAction', due: today+'T00:00:00.000Z', connId: 'g1', listId: 'l1' },
  { id: 't2', title: 'Prepare Q3 board deck', status: 'needsAction', due: '2026-07-15T00:00:00.000Z', connId: 'g1', listId: 'l1' },
  { id: 't3', title: 'Review pull requests', status: 'needsAction', due: '2026-07-08T00:00:00.000Z', connId: 'g1', listId: 'l1' },
  { id: 't4', title: 'Book flights for the conference', status: 'needsAction', due: null, connId: 'g1', listId: 'l1' },
]
const state = { timezone: 'America/New_York', projects: [
  { id: '1', name: 'Cartstrings Q3 growth', color: '#8E24AA', note: 'Top priority' },
  { id: '2', name: 'Personal admin', color: '#0B8043', note: '' },
], blocks: { [today]: [
  { id: 'b1', start: 660, end: 720, projectId: '1' },
  { id: 'b2', start: 900, end: 990, title: 'Deep work: write spec', color: '#039BE5', tasks: [{ id: 't2', title: 'Prepare Q3 board deck', status: 'needsAction' }] },
] }, favorites: [
  { id: 'p:1', kind: 'project', label: 'Cartstrings Q3 growth', color: '#8E24AA', projectId: '1', payload: { kind: 'project', projectId: '1' } },
  { id: 't:g1:l1:1', kind: 'task', label: 'Follow up with Acme about the renewal contract terms', color: '#2563eb', payload: { kind: 'task', task: {} } },
], selectedCalendars: ['g1::primary'], selectedTaskLists: ['g1::l1'] }

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
await p.route('**/api/data', (r) => r.request().method() === 'GET' ? r.fulfill(json({ state })) : r.fulfill(json({ ok: true })))
await p.route('**/api/connections', (r) => r.fulfill(json({ connections: [{ id: 'g1', provider: 'google', account_email: 'you@cartstrings.com', extra: { features: ['calendar','tasks'] } }] })))
await p.route('**/api/google/data', (r) => {
  const body = JSON.parse(r.request().postData() || '{}')
  if (body.action === 'calendars') return r.fulfill(json({ accounts: [{ connId: 'g1', email: 'you@cartstrings.com', calendars: [{ id: 'primary', summary: 'Work', primary: true }] }] }))
  if (body.action === 'taskLists') return r.fulfill(json({ accounts: [{ connId: 'g1', email: 'you@cartstrings.com', lists: [{ id: 'l1', title: 'My Tasks' }] }] }))
  if (body.action === 'eventsRange') return r.fulfill(json({ events }))
  if (body.action === 'tasks') return r.fulfill(json({ tasks: gtasks }))
  return r.fulfill(json({}))
})
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
async function shot(name) { await p.screenshot({ path: OUT + name + '.png' }) }
await shot('r-day')
await p.keyboard.press('w'); await p.waitForTimeout(600); await shot('r-week')
await p.keyboard.press('m'); await p.waitForTimeout(600); await shot('r-month')
await p.keyboard.press('d'); await p.waitForTimeout(400)
// open connections modal
const conn = await p.$('.conn-btn'); if (conn) { await conn.click(); await p.waitForTimeout(500); await shot('r-connections') ; await p.keyboard.press('Escape') }
await p.waitForTimeout(200)
// open a project modal
const proj = await p.$('.proj-name'); if (proj) { await proj.click(); await p.waitForTimeout(400); await shot('r-project'); await p.keyboard.press('Escape') }
await b.close()
console.log('ok')
