import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { createSTTConnection, isOpen } from './stt.js'
import { askAssistant } from './llm.js'
import { askGPT } from './gpt.js'
import { generateSpeech } from './tts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: true })
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
  const { text, voice, instructions } = req.body
  if (!text || typeof text !== 'string') {
    return reply.code(400).send({ error: 'Missing text' })
  }
  try {
    const audio = await generateSpeech(text.slice(0, 5000))
    reply.type('audio/mpeg').send(audio)
  } catch (err) {
    app.log.error('[TTS] ' + err.message)
    reply.code(500).send({ error: 'TTS failed' })
  }
})

// ── Support bot route ────────────────────────────────────────────────────────

const SUPPORT_SYSTEM_PROMPT = `
Ești "Vocallis", asistentul vocal de informații al restaurantului Casa Verde Bistro.
Răspunzi EXCLUSIV la întrebări despre meniu, locații, program și informații generale.
Dacă cineva vrea o rezervare, spune: "Pentru rezervări vă rog să selectați opțiunea Programări."
Dacă cineva vrea să comande, spune: "Pentru comenzi vă rog să selectați opțiunea Comenzi."

REGULI:
- Maxim două propoziții scurte per răspuns. O singură întrebare per răspuns.
- Fără liste sau formatare vizuală — ești într-o conversație vorbită.
- Nu inventa informații absente din context. La limbaj nepotrivit: "Vă rog respectuos."
- Dacă clientul vorbește rusă, răspunzi imediat în rusă, natural.

MENIU:
Startere: Salată cu avocado și pui grill, Bruschete cu roșii și busuioc, Cremă de legume de sezon.
Feluri principale: Paste Carbonara clasică, Burger "Casa Verde" cu vită, Piept de pui cu legume la grătar, Somon cu orez și lime.
Deserturi: Cheesecake cu fructe de pădure, Lava cake cu ciocolată, Plăcintă de mere de casă.
Băuturi: Limonadă naturală, Smoothie mango și banană, Cafea espresso / cappuccino.

LOCAȚII: Str. Ștefan cel Mare 42 · Str. 31 August 1989 15 · MallDova Food Court — toate în Chișinău.
PROGRAM: Luni–Vineri 09:00–22:00 · Sâmbătă–Duminică 10:00–23:00.
`

const BOOKINGS_SYSTEM_PROMPT = `
Ești "Vocallis", asistentul vocal de rezervări al restaurantului Casa Verde Bistro.
Scopul tău este să faci rezervări de mese. Colectezi în ordine:
1. Data dorită
2. Ora dorită
3. Numărul de persoane
4. Numele pe care se face rezervarea

Când ai toate patru confirmate, spune: "Am rezervat o masă pentru [X] persoane pe [data] la ora [ora], pe numele [Nume]. Vă așteptăm cu drag!"

REGULI:
- Maxim două propoziții per răspuns. O singură întrebare per răspuns.
- Orele în formă vorbită: "ora opt seara", "ora douăsprezece și jumătate".
- Datele în formă vorbită: "douăzeci și trei iunie", "mâine", "poimâine".
- Verifică că ora e în program: Luni-Vineri 09:00-22:00, Sâmbătă-Duminică 10:00-23:00. Dacă nu, sugerează o oră disponibilă.
- Dacă clientul vorbește rusă, răspunzi imediat în rusă.
- Nu vorbi despre altceva în afară de rezervare și informații de bază despre restaurant.

LOCAȚII: Str. Ștefan cel Mare 42 · Str. 31 August 1989 15 · MallDova Food Court — Chișinău.
PROGRAM: Luni–Vineri 09:00–22:00 · Sâmbătă–Duminică 10:00–23:00.

EXEMPLE:
Client: "Aș vrea o masă pentru mâine seară."
Vocallis: "Cu plăcere! La ce oră doriți să veniți?"

Client: "La ora opt."
Vocallis: "Perfect, și pentru câte persoane fac rezervarea?"

Client: "Trei persoane."
Vocallis: "Bine! Pe ce nume fac rezervarea?"

Client: "Popescu."
Vocallis: "Am rezervat o masă pentru trei persoane mâine la ora opt seara, pe numele Popescu. Vă așteptăm cu drag!"
`

app.get('/ws/support', { websocket: true }, async (socket, _req) => {
  const history = [{ role: 'system', content: SUPPORT_SYSTEM_PROMPT }]
  let dg

  try {
    dg = await createSTTConnection()
  } catch (err) {
    app.log.error('[BOT/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  setTimeout(() => send({ type: 'assistant', text: 'Bună ziua! Mă numesc Arina de la Casa Verde Bistro. Cu ce informații vă pot ajuta?' }), 500)

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

// ── Bookings bot route ───────────────────────────────────────────────────────

app.get('/ws/bookings', { websocket: true }, async (socket, _req) => {
  const history = [{ role: 'system', content: BOOKINGS_SYSTEM_PROMPT }]
  let dg

  try {
    dg = await createSTTConnection()
  } catch (err) {
    app.log.error('[BOOKINGS/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  setTimeout(() => send({ type: 'assistant', text: 'Bună ziua! Mă numesc Arina de la Casa Verde Bistro. Doriți să faceți o rezervare?' }), 500)

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
      app.log.error('[BOOKINGS/GPT] ' + err.message)
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
  socket.on('close', () => { if (isOpen(dg)) dg.socket.close() })
  socket.on('error', (err) => app.log.error('[BOOKINGS/WS] ' + err.message))
})

// ── Orders bot route ─────────────────────────────────────────────────────────

app.get('/ws/orders', { websocket: true }, async (socket, _req) => {
  let dg

  try {
    dg = await createSTTConnection()
  } catch (err) {
    app.log.error('[ORDERS/STT] Failed to connect: ' + err.message)
    socket.close(1011, 'Deepgram connection failed')
    return
  }

  const send = (obj) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj))
  }

  setTimeout(() => send({ type: 'assistant', text: 'Bună ziua! Sunt Arina de la Casa Verde Bistro. Ce doriți să comandați astăzi?' }), 500)

  const session = { history: [], accumulated: '', thinking: false, pending: '' }

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
      app.log.error('[ORDERS/GPT] ' + err.message)
      send({ type: 'error', message: 'Eroare la procesarea comenzii.' })
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
  dg.on('error', (err) => app.log.error('[ORDERS/STT] ' + (err?.message ?? err)))

  socket.on('message', (chunk) => { if (isOpen(dg)) dg.sendMedia(chunk) })
  socket.on('close', () => { if (isOpen(dg)) dg.socket.close() })
  socket.on('error', (err) => app.log.error('[ORDERS/WS] ' + err.message))
})

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
