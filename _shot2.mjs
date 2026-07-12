import { chromium } from 'playwright-core'
const today = '2026-07-12'
const cache = {
  tz: 'America/New_York',
  connections: [{ id: 'g1', provider: 'google', account_email: 'you@work.com' }],
  calAccounts: [{ connId: 'g1', email: 'you@work.com', calendars: [{ id: 'primary', summary: 'Work' }] }],
  selectedCalendars: ['g1::primary'],
  favorites: [
    { id: 'p:1', kind: 'project', label: 'Cartstrings Q3 growth marketing initiative', color: '#8E24AA', projectId: '1', payload: { kind: 'project', projectId: '1' } },
    { id: 'z:2', kind: 'zohoproject', label: 'Website redesign — landing pages', color: '#e42527', payload: { kind: 'batch', title: 'Website redesign', tasks: [] } },
    { id: 't:g1:l1:9', kind: 'task', label: 'Follow up with Acme about renewal contract', color: '#2563eb', payload: { kind: 'task', task: {} } },
  ],
  projects: [{ id: '1', name: 'Cartstrings Q3 growth marketing initiative', color: '#8E24AA', note: 'Top priority this quarter' }],
  eventsByDate: {
    [today]: [
      { id: 'e1', title: 'Product sync with design team', start: 600, end: 660, link: 'https://meet.google.com/abc-defg-hij', location: 'Conference Room B', organizer: 'Sarah Chen', description: 'Review the new onboarding flow.\nAgenda:\n- Metrics\n- Q3 roadmap\nDoc: https://docs.google.com/document/d/xyz', attendees: [{ name: 'Sarah Chen', status: 'accepted', self: false }, { name: 'You', status: 'accepted', self: true }, { name: 'Mark Lee', status: 'tentative', self: false }] },
      { id: 'e2', title: '1:1 with manager', start: 840, end: 870, link: null, location: null, organizer: 'Manager', description: null, attendees: [] },
    ],
  },
  gtasks: [], taskAccounts: [], zoho: null, focusHidden: true, view: 'day', sidebarOpen: true, sections: { projects: false, tasks: false },
}
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
await p.addInitScript((c) => { localStorage.setItem('focus_cache', JSON.stringify(c)) }, cache)
await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p.waitForTimeout(1000)
await p.screenshot({ path: process.argv[2] })
// open the event
const ev = await p.$('.ev-meeting')
if (ev) { await ev.click(); await p.waitForTimeout(500); await p.screenshot({ path: process.argv[2].replace('.png', '-event.png') }) }
await b.close()
console.log('ok')
