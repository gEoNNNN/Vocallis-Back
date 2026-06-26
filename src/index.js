import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { createSTTConnection, isOpen } from './stt.js'
import { askAssistant } from './llm.js'
import { askBookings } from './bookings-llm.js'
import { askGPT } from './gpt.js'
import { generateSpeech } from './tts.js'
import { sendLead } from './telegram.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true })

function tsNow() {
  const n = new Date()
  return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`
}

const PORT = Number(process.env.PORT) || 3000

// ── Plugins ───────────────────────────────────────────────────────────────────
await app.register(cors, { origin: true })
await app.register(websocket)
await app.register(staticFiles, { root: join(__dirname, '..', 'public') })

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/ws/stt', { websocket: true }, async (socket, _req) => {
  let dg

  try {
    dg = await createSTTConnection()
  } catch (err) {
    app.log.error('[STT] Failed to connect to Deepgram: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  // Deepgram → browser: trimite transcript
  dg.on('message', (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      if (alt?.transcript && socket.readyState === 1) {
        socket.send(JSON.stringify({
          transcript: alt.transcript,
          is_final: data.is_final,
        }))
      }
    }
  })

  dg.on('close', () => {
    if (socket.readyState === 1) socket.close()
  })

  dg.on('error', (err) => app.log.error('[STT] ' + (err?.message ?? err)))

  // Browser audio → Deepgram
  socket.on('message', (chunk) => {
    if (isOpen(dg)) dg.sendMedia(chunk)
  })

  socket.on('close', () => {
    if (isOpen(dg)) dg.socket.close()
  })

  socket.on('error', (err) => app.log.error('[WS] ' + err.message))
})

// ── Assistant route ──────────────────────────────────────────────────────────

app.get('/ws/assistant', { websocket: true }, async (socket, _req) => {
  let dg

  try {
    dg = await createSTTConnection()
  } catch (err) {
    app.log.error('[ASSISTANT] Deepgram failed: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  const session = {
    history: [],
    accumulated: '',
    thinking: false,
    pending: '',
  }

  async function processUtterance(userText) {
    send({ type: 'user', text: userText })
    send({ type: 'thinking' })
    session.thinking = true

    try {
      const result = await askAssistant(session.history, userText)
      session.history.push(...result.historyEntries)
      if (result.order) send({ type: 'order_confirmed', order: result.order })
      send({ type: 'assistant', text: result.text })
    } catch (err) {
      app.log.error('[ASSISTANT] GPT-4o error: ' + err.message)
      send({ type: 'error', message: 'Eroare la procesarea răspunsului.' })
    } finally {
      session.thinking = false
      // Procesează fraza rostită în timp ce GPT gândea (nu o pierde)
      const queued = session.pending.trim()
      if (queued) {
        session.pending = ''
        processUtterance(queued)
      }
    }
  }

  dg.on('message', (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''

      if (!data.is_final) {
        if (text) send({ type: 'interim', text: session.accumulated + text })
        return
      }

      if (text) session.accumulated += (session.accumulated ? ' ' : '') + text
    }

    if (data.type === 'UtteranceEnd') {
      const userText = session.accumulated.trim()
      session.accumulated = ''
      if (!userText) return

      // Dacă GPT încă răspunde, păstrează fraza în coadă în loc s-o pierzi
      if (session.thinking) {
        session.pending += (session.pending ? ' ' : '') + userText
        return
      }

      processUtterance(userText)
    }
  })

  dg.on('close', () => { if (socket.readyState === 1) socket.close() })
  dg.on('error', (err) => app.log.error('[ASSISTANT] DG error: ' + (err?.message ?? err)))

  socket.on('message', (chunk) => {
    if (isOpen(dg)) dg.sendMedia(chunk)
  })

  socket.on('close', () => {
    if (isOpen(dg)) dg.socket.close()
  })

  socket.on('error', (err) => app.log.error('[ASSISTANT] WS error: ' + err.message))
})

// ── TTS route ───────────────────────────────────────────────────────────────

app.post('/api/tts', async (req, reply) => {
  const { text, lang } = req.body
  if (!text || typeof text !== 'string') {
    return reply.code(400).send({ error: 'Missing text' })
  }
  try {
    const audio = await generateSpeech(text.slice(0, 5000), lang ?? 'ro')
    reply.type('audio/mpeg').send(audio)
  } catch (err) {
    app.log.error('[TTS] ' + err.message)
    reply.code(500).send({ error: 'TTS failed' })
  }
})

// ── Support bot route ────────────────────────────────────────────────────────

const SUPPORT_SYSTEM_PROMPT = {
  ro: `Ești "Vocallis", asistentul vocal de informații al restaurantului Casa Verde Bistro.
Răspunzi EXCLUSIV la întrebări despre meniu, locații, program și informații generale.
Dacă cineva vrea o rezervare, spune: "Pentru rezervări selectați opțiunea Programări."
Dacă cineva vrea să comande, spune: "Pentru comenzi selectați opțiunea Comenzi."
Maxim două propoziții. Fără liste. Nu inventa informații.
MENIU: Salată avocado-pui, Bruschete, Cremă de legume | Paste Carbonara, Burger Casa Verde, Pui grill, Somon lime | Cheesecake, Lava cake, Plăcintă mere | Limonadă, Smoothie mango, Espresso/Cappuccino.
LOCAȚII: Str. Ștefan cel Mare 42 · Str. 31 August 1989 15 · MallDova Food Court — Chișinău.
PROGRAM: Luni–Vineri 09:00–22:00 · Sâmbătă–Duminică 10:00–23:00.`,
  ru: `Ты «Вокаллис», голосовой информационный ассистент Casa Verde Bistro. Отвечай всегда на русском.
Отвечай ТОЛЬКО на вопросы о меню, адресах, графике работы.
Если хотят бронь: «Для бронирования выберите опцию Программари.» Если заказ: «Для заказа выберите Команзи.»
Максимум два предложения. Без списков. Не придумывай информацию.
МЕНЮ: Салат авокадо-курица, Брускетты, Крем-суп | Паста Карбонара, Бургер Casa Verde, Курица гриль, Лосось с лаймом | Чизкейк, Лава-кейк, Яблочный пирог | Лимонад, Смузи манго, Эспрессо/Капучино.
АДРЕСА: ул. Штефан чел Маре 42 · ул. 31 Августа 1989 15 · MallDova Food Court — Кишинёв.
ГРАФИК: Пн–Пт 09:00–22:00 · Сб–Вс 10:00–23:00.`,
}

const BOOKINGS_SYSTEM_PROMPT = {
  ro: `Ești "Vocallis", asistentul vocal de rezervări al restaurantului Casa Verde Bistro.
Colectezi în ordine: 1. Data 2. Ora 3. Nr. persoane 4. Numele rezervării.
Când ai toate patru confirmate, spune: "Am rezervat o masă pentru [X] persoane pe [data] la ora [ora], pe numele [Nume]. Vă așteptăm!"
Maxim două propoziții. O întrebare per răspuns. Orele în formă vorbită. Program: Luni–Vineri 09:00–22:00, Sâmbătă–Duminică 10:00–23:00.`,
  ru: `Ты «Вокаллис», ассистент по бронированию Casa Verde Bistro. Отвечай всегда на русском.
Собирай по порядку: 1. Дата 2. Время 3. Кол-во гостей 4. Имя для бронирования.
Когда все подтверждено: «Столик забронирован на [X] человек [дата] в [время] на имя [Имя]. Ждём вас!»
Максимум два предложения. Один вопрос за раз. График: Пн–Пт 09:00–22:00, Сб–Вс 10:00–23:00.`,
}

app.get('/ws/support', { websocket: true }, async (socket, req) => {
  const lang = req.query.lang === 'ru' ? 'ru' : 'ro'
  const history = [{ role: 'system', content: SUPPORT_SYSTEM_PROMPT[lang] }]
  let dg

  try {
    dg = await createSTTConnection({ language: lang })
  } catch (err) {
    app.log.error('[BOT/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  const greeting = lang === 'ru'
    ? 'Добрый день! Меня зовут Арина, я из Casa Verde Bistro. Чем могу помочь?'
    : 'Bună ziua! Mă numesc Arina de la Casa Verde Bistro. Cu ce informații vă pot ajuta?'
  setTimeout(() => send({ type: 'assistant', text: greeting }), 500)

  const session = { accumulated: '', thinking: false, pending: '' }

  async function processUtterance(userText) {
    send({ type: 'user', text: userText })
    history.push({ role: 'user', content: userText })
    send({ type: 'thinking' })
    session.thinking = true

    let fullResponse = ''
    try {
      await askGPT(userText, (chunk) => {
        fullResponse += chunk
        send({ type: 'assistant_chunk', content: chunk })
      }, history.slice(0, -1))
      history.push({ role: 'assistant', content: fullResponse })
      send({ type: 'assistant_end' })
    } catch (err) {
      app.log.error('[BOT/GPT] ' + err.message)
      send({ type: 'error', message: 'Eroare GPT: ' + err.message })
    } finally {
      session.thinking = false
      const queued = session.pending.trim()
      if (queued) {
        session.pending = ''
        processUtterance(queued)
      }
    }
  }

  dg.on('message', (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''
      if (!data.is_final) {
        if (text) send({ type: 'interim', text: session.accumulated + text })
        return
      }
      if (text) session.accumulated += (session.accumulated ? ' ' : '') + text
    }

    if (data.type === 'UtteranceEnd') {
      const userText = session.accumulated.trim()
      session.accumulated = ''
      if (!userText) return

      // Dacă GPT încă răspunde, păstrează fraza în coadă în loc s-o pierzi
      if (session.thinking) {
        session.pending += (session.pending ? ' ' : '') + userText
        return
      }

      processUtterance(userText)
    }
  })

  dg.on('close', () => { if (socket.readyState === 1) socket.close() })
  dg.on('error', (err) => app.log.error('[BOT/STT] ' + (err?.message ?? err)))

  socket.on('message', (chunk) => { if (isOpen(dg)) dg.sendMedia(chunk) })
  socket.on('close', () => { if (isOpen(dg)) dg.socket.close() })
  socket.on('error', (err) => app.log.error('[BOT/WS] ' + err.message))
})

// ── Bookings bot route (GPT-4o + Google Calendar tool calling) ───────────────

app.get('/ws/bookings', { websocket: true }, async (socket, req) => {
  const lang = req.query.lang === 'ru' ? 'ru' : 'ro'
  const history = [{ role: 'system', content: BOOKINGS_SYSTEM_PROMPT[lang] }]
  let dg

  try {
    dg = await createSTTConnection({ language: lang })
  } catch (err) {
    app.log.error('[BOOKINGS/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  const greeting = lang === 'ru'
    ? 'Добрый день! Меня зовут Арина из Casa Verde Bistro. Хотите забронировать столик?'
    : 'Bună ziua! Mă numesc Arina de la Casa Verde Bistro. Doriți să faceți o rezervare?'
  setTimeout(() => send({ type: 'assistant', text: greeting }), 500)

  const session = {
    history:     [],
    accumulated: '',
    thinking:    false,
    pending:     '',
    transcript:  [],
    completed:   false,
    bookingData: null,
  }

  async function processUtterance(userText) {
    session.transcript.push({ role: 'client', text: userText, ts: tsNow() })
    send({ type: 'user', text: userText })
    send({ type: 'thinking' })
    session.thinking = true

    try {
      const result = await askBookings(session.history, userText)
      session.history.push(...result.historyEntries)
      session.transcript.push({ role: 'arina', text: result.text, ts: tsNow() })

      if (result.booking) {
        session.completed   = true
        session.bookingData = result.booking
        send({ type: 'booking_confirmed', booking: result.booking })
      }

      send({ type: 'assistant', text: result.text })
    } catch (err) {
      app.log.error('[BOOKINGS/GPT] ' + err.message)
      send({ type: 'error', message: 'Eroare la procesarea rezervării.' })
    } finally {
      session.thinking = false
      const queued = session.pending.trim()
      if (queued) {
        session.pending = ''
        processUtterance(queued)
      }
    }
  }

  dg.on('message', (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''
      if (!data.is_final) {
        if (text) send({ type: 'interim', text: session.accumulated + text })
        return
      }
      if (text) session.accumulated += (session.accumulated ? ' ' : '') + text
    }

    if (data.type === 'UtteranceEnd') {
      const userText = session.accumulated.trim()
      session.accumulated = ''
      if (!userText) return
      if (session.thinking) {
        session.pending += (session.pending ? ' ' : '') + userText
        return
      }
      processUtterance(userText)
    }
  })

  dg.on('close', () => { if (socket.readyState === 1) socket.close() })
  dg.on('error', (err) => app.log.error('[BOOKINGS/STT] ' + (err?.message ?? err)))

  socket.on('message', (chunk) => { if (isOpen(dg)) dg.sendMedia(chunk) })
  socket.on('close', () => {
    if (isOpen(dg)) dg.socket.close()
    if (session.completed && session.bookingData) {
      sendLead('booking', session.bookingData, session.transcript).catch(
        (err) => app.log.error('[BOOKINGS/TG] ' + err.message)
      )
    }
  })
  socket.on('error', (err) => app.log.error('[BOOKINGS/WS] ' + err.message))
})

// ── Orders bot route ─────────────────────────────────────────────────────────

app.get('/ws/orders', { websocket: true }, async (socket, req) => {
  const lang = req.query.lang === 'ru' ? 'ru' : 'ro'
  let dg

  try {
    dg = await createSTTConnection({ language: lang })
  } catch (err) {
    app.log.error('[ORDERS/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  const greeting = lang === 'ru'
    ? 'Добрый день! Я Арина из Casa Verde Bistro. Что желаете заказать?'
    : 'Bună ziua! Sunt Arina de la Casa Verde Bistro. Ce doriți să comandați astăzi?'
  setTimeout(() => send({ type: 'assistant', text: greeting }), 500)

  const session = {
    history:    [],
    accumulated: '',
    thinking:   false,
    pending:    '',
    transcript: [],
    completed:  false,
    orderData:  null,
  }

  async function processUtterance(userText) {
    session.transcript.push({ role: 'client', text: userText, ts: tsNow() })
    send({ type: 'user', text: userText })
    send({ type: 'thinking' })
    session.thinking = true

    try {
      const result = await askAssistant(session.history, userText, lang)
      session.history.push(...result.historyEntries)
      session.transcript.push({ role: 'arina', text: result.text, ts: tsNow() })

      if (result.order) {
        session.completed = true
        session.orderData = result.order
        send({ type: 'order_confirmed', order: result.order })
      }

      send({ type: 'assistant', text: result.text })
    } catch (err) {
      app.log.error('[ORDERS/GPT] ' + err.message)
      send({ type: 'error', message: 'Eroare la procesarea comenzii.' })
    } finally {
      session.thinking = false
      const queued = session.pending.trim()
      if (queued) {
        session.pending = ''
        processUtterance(queued)
      }
    }
  }

  dg.on('message', (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''
      if (!data.is_final) {
        if (text) send({ type: 'interim', text: session.accumulated + text })
        return
      }
      if (text) session.accumulated += (session.accumulated ? ' ' : '') + text
    }

    if (data.type === 'UtteranceEnd') {
      const userText = session.accumulated.trim()
      session.accumulated = ''
      if (!userText) return

      // Dacă GPT încă răspunde, păstrează fraza în coadă în loc s-o pierzi
      if (session.thinking) {
        session.pending += (session.pending ? ' ' : '') + userText
        return
      }

      processUtterance(userText)
    }
  })

  dg.on('close', () => { if (socket.readyState === 1) socket.close() })
  dg.on('error', (err) => app.log.error('[ORDERS/STT] ' + (err?.message ?? err)))

  socket.on('message', (chunk) => { if (isOpen(dg)) dg.sendMedia(chunk) })
  socket.on('close', () => {
    if (isOpen(dg)) dg.socket.close()
    if (session.completed && session.orderData) {
      sendLead('order', session.orderData, session.transcript).catch(
        (err) => app.log.error('[ORDERS/TG] ' + err.message)
      )
    }
  })
  socket.on('error', (err) => app.log.error('[ORDERS/WS] ' + err.message))
})

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
