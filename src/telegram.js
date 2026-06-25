const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID

const API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ── Helpers ───────────────────────────────────────────────────────────────────

function escMd(str) {
  return String(str ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
}

function nowRo() {
  return new Date().toLocaleString('ro-RO', {
    timeZone: 'Europe/Chisinau',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Telegram API calls ────────────────────────────────────────────────────────

async function apiCall(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`)
  return json
}

async function sendDocument(chatId, filename, content, caption) {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="chat_id"`,
    '',
    String(chatId),
    `--${boundary}`,
    `Content-Disposition: form-data; name="caption"`,
    '',
    caption,
    `--${boundary}`,
    `Content-Disposition: form-data; name="document"; filename="${filename}"`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n')

  const res = await fetch(`${API}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Telegram sendDocument failed: ${json.description}`)
  return json
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildOrderMessage(fields) {
  return (
    `🛒 *Comandă nouă — Casa Verde Bistro*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: \`${escMd(fields.id)}\`\n` +
    `👤 Client: ${escMd(fields.customer_name)}\n` +
    `🍽 Preparate: ${escMd(fields.items)}\n` +
    `📦 Tip: ${escMd(fields.order_type)}\n` +
    (fields.address && fields.address !== 'N/A'
      ? `📍 Adresă: ${escMd(fields.address)}\n`
      : '') +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${escMd(nowRo())} · Via Vocallis AI`
  )
}

function buildBookingMessage(fields) {
  return (
    `📅 *Rezervare nouă — Casa Verde Bistro*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: \`${escMd(fields.id)}\`\n` +
    `👤 Nume: ${escMd(fields.customer_name)}\n` +
    `📆 Data: ${escMd(fields.date)}\n` +
    `🕐 Ora: ${escMd(fields.time)}\n` +
    `👥 Persoane: ${escMd(fields.guests)}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${escMd(nowRo())} · Via Vocallis AI`
  )
}

// ── Transcript formatter ───────────────────────────────────────────────────────

export function formatTranscript(type, transcript) {
  const header = type === 'booking'
    ? `=== Transcript Rezervare — ${nowRo()} ===`
    : `=== Transcript Comandă — ${nowRo()} ===`

  const lines = transcript.map(entry =>
    `[${entry.ts}] ${entry.role === 'client' ? 'Client' : 'Arina'}: ${entry.text}`
  )

  return [header, '', ...lines, ''].join('\n')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a lead notification + transcript file to Telegram.
 * @param {'booking'|'order'} type
 * @param {object} fields   - order or booking details
 * @param {Array}  transcript - [{ role: 'client'|'arina', text, ts }]
 */
export async function sendLead(type, fields, transcript) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[TELEGRAM] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping')
    return
  }

  const message  = type === 'booking' ? buildBookingMessage(fields) : buildOrderMessage(fields)
  const txtName  = type === 'booking'
    ? `rezervare-${fields.id}.txt`
    : `comanda-${fields.id}.txt`
  const txtBody  = formatTranscript(type, transcript)

  try {
    await apiCall('sendMessage', {
      chat_id:    CHAT_ID,
      text:       message,
      parse_mode: 'MarkdownV2',
    })
    await sendDocument(CHAT_ID, txtName, txtBody, `📎 Transcript — ${fields.id}`)
    console.log(`[TELEGRAM] Lead sent: ${fields.id}`)
  } catch (err) {
    console.error('[TELEGRAM] Failed to send lead:', err.message)
  }
}
