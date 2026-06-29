import { DeepgramClient } from '@deepgram/sdk'
import { EventEmitter } from 'events'

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY })

/**
 * Creează și deschide o conexiune live STT Deepgram.
 * Returnează un obiect compatibil EventEmitter: .on('message'|'close'|'error')
 * @param {object} opts - opțiuni opționale
 * @returns {Promise<object>} conexiune gata de utilizat
 */
const KEYTERMS = {
  ro: [
    // Numbers 1-20
    'unu', 'doi', 'trei', 'patru', 'cinci',
    'șase', 'șapte', 'opt', 'nouă', 'zece',
    'unsprezece', 'doisprezece', 'treisprezece', 'paisprezece', 'cincisprezece',
    'șaisprezece', 'șaptesprezece', 'optsprezece', 'nouăsprezece', 'douăzeci',
    // Days
    'astăzi', 'mâine', 'poimâine',
    // Menu items
    'Carbonara', 'avocado', 'bruschete', 'cheesecake',
    'limonadă', 'smoothie', 'espresso', 'cappuccino',
  ],
  ru: [
    // Numbers 1-20
    'один', 'два', 'три', 'четыре', 'пять',
    'шесть', 'семь', 'восемь', 'девять', 'десять',
    'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
    'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать', 'двадцать',
    // Days
    'сегодня', 'завтра', 'послезавтра',
    // Menu items
    'Карбонара', 'авокадо', 'брускетты', 'чизкейк',
    'лимонад', 'смузи', 'эспрессо', 'капучино',
  ],
}

export async function createSTTConnection(opts = {}) {
  const lang = opts.language ?? 'ro'
  // În SDK v5 createConnection() returnează un Promise
  const conn = await deepgram.listen.v1.createConnection({
    model: 'nova-3',
    language: 'ro',
    smart_format: false,
    interim_results: true,
    utterance_end_ms: 2000,
    endpointing: 800,
    punctuate: true,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    keyterms: KEYTERMS[lang] ?? KEYTERMS.ro,
    ...opts,
  })

  // Conectează și așteaptă deschiderea
  await new Promise((resolve, reject) => {
    conn.handleOpen  = resolve
    conn.handleError = reject
    conn.connect()
  })

  // Wrap cu EventEmitter. IMPORTANT: folosim listener direct pe socket,
  // pentru că override-ul conn.handleMessage NU funcționează — SDK-ul leagă
  // handler-ul intern la connect(), înainte să-l putem suprascrie.
  const emitter = new EventEmitter()

  conn.socket.addEventListener('message', (event) => {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      emitter.emit('message', data)
    } catch (e) {
      emitter.emit('error', e)
    }
  })
  // Keepalive la fiecare 8s — previne timeout-ul Deepgram când microfonul e mut (ex: TTS activ)
  const keepAliveTimer = setInterval(() => {
    if (conn.socket.readyState === 1) {
      conn.socket.send(JSON.stringify({ type: 'KeepAlive' }))
    }
  }, 8000)

  conn.socket.addEventListener('close', () => {
    clearInterval(keepAliveTimer)
    emitter.emit('close')
  })
  conn.socket.addEventListener('error', (e) => emitter.emit('error', e))

  console.log('[STT] Ready')

  return {
    on:        (ev, cb) => emitter.on(ev, cb),
    off:       (ev, cb) => emitter.off(ev, cb),
    sendMedia: (chunk)  => conn.sendMedia(chunk),
    socket:    conn.socket,
  }
}

/**
 * Verifică dacă conexiunea Deepgram e deschisă.
 */
export function isOpen(conn) {
  return conn?.socket?.readyState === 1
}
