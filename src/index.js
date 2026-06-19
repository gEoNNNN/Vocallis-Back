import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { createSTTConnection, isOpen } from './stt.js'
import { askAssistant } from './llm.js'

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
  }

  dg.on('message', async (data) => {
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

      if (!userText || session.thinking) return

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
      }
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

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
