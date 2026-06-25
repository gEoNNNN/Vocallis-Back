import { google } from 'googleapis'

const CALENDAR_ID      = process.env.GOOGLE_CALENDAR_ID || 'primary'
const BOOKING_CAPACITY = Number(process.env.BOOKING_CAPACITY) || 2
const TZ               = 'Europe/Chisinau'

// ── Auth ──────────────────────────────────────────────────────────────────────

function isCalendarConfigured() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!raw || !raw.trim()) return false
  try {
    const parsed = JSON.parse(raw)
    return !!(parsed.client_email && parsed.private_key)
  } catch {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
      return !!(parsed.client_email && parsed.private_key)
    } catch {
      return false
    }
  }
}

function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY

  let credentials
  try {
    credentials = JSON.parse(raw)
  } catch {
    try {
      credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON or base64-encoded JSON')
    }
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })
}

function getCalendar() {
  const auth = getAuthClient()
  return google.calendar({ version: 'v3', auth })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse "YYYY-MM-DD" + "HH:MM" into two ISO strings (start, end).
 * @param {string} date  - "2026-06-25"
 * @param {string} time  - "19:00"
 * @returns {{ start: string, end: string }}
 */
function slotRange(date, time) {
  const [h, m] = time.split(':').map(Number)
  const start  = new Date(`${date}T${time}:00`)
  const end    = new Date(start)
  end.setHours(end.getHours() + 1)
  return {
    start: start.toISOString(),
    end:   end.toISOString(),
  }
}

/**
 * Return list of candidate hours (business hours) for a given date.
 * Mon–Fri 09:00–22:00, Sat–Sun 10:00–23:00 (last bookable slot 1h before close)
 */
function businessHours(date) {
  const d = new Date(`${date}T12:00:00`)
  const day = d.getDay() // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6
  const start = isWeekend ? 10 : 9
  const end   = isWeekend ? 22 : 21
  const hours = []
  for (let h = start; h <= end; h++) {
    hours.push(`${String(h).padStart(2, '0')}:00`)
  }
  return hours
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all events for a calendar day in one API call and return per-hour counts.
 * @param {string} date - "YYYY-MM-DD"
 * @returns {Promise<Map<string, number>>}  hour "HH:00" → overlap count
 */
async function dayEventCounts(date, calendar) {
  const dayStart = new Date(`${date}T00:00:00`).toISOString()
  const dayEnd   = new Date(`${date}T23:59:59`).toISOString()

  const res = await calendar.events.list({
    calendarId:   CALENDAR_ID,
    timeMin:      dayStart,
    timeMax:      dayEnd,
    singleEvents: true,
    orderBy:      'startTime',
  })

  const events = res.data.items ?? []
  const hours  = businessHours(date)
  const counts = new Map()

  for (const hour of hours) {
    const { start: sISO, end: eISO } = slotRange(date, hour)
    const s = new Date(sISO).getTime()
    const e = new Date(eISO).getTime()
    const n = events.filter(ev => {
      const evS = new Date(ev.start.dateTime ?? ev.start.date).getTime()
      const evE = new Date(ev.end.dateTime   ?? ev.end.date).getTime()
      return evS < e && evE > s
    }).length
    counts.set(hour, n)
  }
  return counts
}

/**
 * Check if a time slot has capacity available.
 * @param {string} date - "YYYY-MM-DD"
 * @param {string} time - "HH:MM"
 * @returns {Promise<{ available: boolean, count: number, freeSlotsToday: string[] }>}
 */
export async function checkSlot(date, time) {
  if (!isCalendarConfigured()) {
    console.warn('[CALENDAR] Not configured — assuming slot is available')
    return { available: true, count: 0, freeSlotsToday: [] }
  }

  const calendar = getCalendar()
  const counts   = await dayEventCounts(date, calendar)

  const normalised = time.length === 5 && time.endsWith(':00') ? time : `${time.split(':')[0].padStart(2, '0')}:00`
  const count      = counts.get(normalised) ?? 0
  const available  = count < BOOKING_CAPACITY

  const freeSlotsToday = available
    ? []
    : [...counts.entries()]
        .filter(([, n]) => n < BOOKING_CAPACITY)
        .map(([h]) => h)

  return { available, count, freeSlotsToday }
}

/**
 * Create a 1-hour reservation event in Google Calendar.
 * @param {{ date: string, time: string, guests: number, customer_name: string }} booking
 * @returns {Promise<{ eventId: string, htmlLink: string, bookingId: string }>}
 */
export async function createBooking({ date, time, guests, customer_name }) {
  const bookingId = `RES-${date.replace(/-/g, '')}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`

  if (!isCalendarConfigured()) {
    console.warn('[CALENDAR] Not configured — booking saved locally only:', bookingId)
    return { eventId: null, htmlLink: null, bookingId }
  }

  const calendar = getCalendar()
  const { start, end } = slotRange(date, time)

  const event = {
    summary:     `Rezervare — ${customer_name} — ${guests} pers.`,
    description: `Rezervare pentru ${guests} persoane pe numele ${customer_name}.\nID: ${bookingId}\nCreat automat de Vocallis AI.`,
    start: { dateTime: start, timeZone: TZ },
    end:   { dateTime: end,   timeZone: TZ },
  }

  const res = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource:   event,
  })

  console.log('[CALENDAR] Event created:', res.data.id, '—', event.summary)

  return {
    eventId:   res.data.id,
    htmlLink:  res.data.htmlLink,
    bookingId,
  }
}
