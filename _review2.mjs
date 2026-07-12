import { chromium } from 'playwright-core'
const today = '2026-07-12'
const OUT = '/tmp/claude-0/-home-user-focus-planner/ab725534-a039-5ccc-8245-4d8d1a6531a1/scratchpad/'
// A meeting happening RIGHT NOW so the focus card shows the Join button.
const nowMin = 13 * 60 + 55
const events = [
  { id: 'e1', title: 'Product sync with design team', date: today, start: nowMin - 20, end: nowMin + 40, link: 'https://meet.google.com/abc', location: 'Conference Room B', organizer: 'Sarah Chen', description: 'Review onboarding.', attendees: [{ name: 'Sarah', status: 'accepted' }, { name: 'You', status: 'accepted', self: true }] },
]
const state = { timezone: 'America/New_York', projects: [{ id: '1', name: 'Cartstrings Q3 growth', color: '#8E24AA', note: 'Top priority' }], blocks: {}, favorites: [], selectedCalendars: ['g1::primary'], selectedTaskLists: [] }
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
  if (body.action === 'tasks') return r.fulfill(json({ tasks: [] }))
  return r.fulfill(json({}))
})
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1000)
// connections modal
const conn = await p.$('.conn-btn'); if (conn) { await conn.click(); await p.waitForTimeout(400); await p.screenshot({ path: OUT + 'r2-connections.png' }); await p.keyboard.press('Escape') }
await p.waitForTimeout(200)
// show focus card
const fb = await p.$('.focus-show'); if (fb) { await fb.click(); await p.waitForTimeout(500); await p.screenshot({ path: OUT + 'r2-focus.png' }) }
await b.close()
console.log('ok')
