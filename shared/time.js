// Timezone helpers shared by the serverless functions and the browser.
//
// The whole app models time as "minutes from midnight" in the OWNER's
// timezone. Serverless functions run in UTC and Google returns tz-aware
// timestamps, so every instant->minutes conversion MUST go through here.

// Minutes from midnight (0..1439) for `input` interpreted in `tz`.
export function toLocalMinutes(input, tz) {
  const d = input instanceof Date ? input : new Date(input)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  let h = 0
  let m = 0
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value)
    else if (p.type === 'minute') m = Number(p.value)
  }
  if (h === 24) h = 0 // some engines emit '24' for midnight with hour12:false
  return h * 60 + m
}

// "YYYY-MM-DD" for `input` (defaults to now) interpreted in `tz`.
export function localDateISO(input, tz) {
  const d = input == null ? new Date() : input instanceof Date ? input : new Date(input)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Current minutes-from-midnight in `tz`.
export function nowMinutes(tz) {
  return toLocalMinutes(new Date(), tz)
}

// Milliseconds that `tz` is ahead of UTC at the given instant.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const m = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second)
  return asUTC - date.getTime()
}

// The UTC instant of a wall-clock time in `tz`.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const ts = Date.UTC(y, mo - 1, d, h, mi, 0)
  const off = tzOffsetMs(new Date(ts), tz)
  return new Date(ts - off)
}

// RFC3339 {timeMin, timeMax} bounding the local day `dateISO` in `tz`, for the
// Google Calendar events query.
export function zonedDayRange(dateISO, tz) {
  const [y, mo, d] = dateISO.split('-').map(Number)
  const start = zonedToUtc(y, mo, d, 0, 0, tz)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}
