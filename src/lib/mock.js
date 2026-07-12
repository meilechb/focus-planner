// Placeholder data for Phase 3 (UI without Google wired yet). Replaced by
// real Google Calendar + Tasks data in Phase 4. Everything here is clearly
// labelled "Demo" in the UI so it is never mistaken for real data.

export const MOCK_MEETINGS = [
  { id: 'm1', title: 'Standup', start: 9 * 60, end: 9 * 60 + 30, calendar: 'Work' },
  { id: 'm2', title: 'Client call — SAB', start: 13 * 60, end: 14 * 60, calendar: 'Work' },
]

export const MOCK_TASK_GROUPS = [
  {
    id: 'demo-google',
    account: 'demo@gmail.com',
    provider: 'google',
    lists: [
      {
        id: 'list-inbox',
        title: 'Inbox',
        tasks: [
          { id: 't1', title: 'Reply to Sarah', status: 'needsAction' },
          { id: 't2', title: 'Review Q3 numbers', status: 'needsAction' },
          { id: 't3', title: 'Book flights', status: 'needsAction' },
        ],
      },
      {
        id: 'list-personal',
        title: 'Personal',
        tasks: [{ id: 't4', title: 'Call dentist', status: 'needsAction' }],
      },
    ],
  },
]
