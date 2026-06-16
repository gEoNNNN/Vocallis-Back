import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { createSTTConnection, isOpen } from './stt.js'

const app = Fastify({ logger: true })
const PORT = Number(process.env.PORT) || 3000

// ── Plugins ───────────────────────────────────────────────────────────────────
await app.register(cors, { origin: true })
await app.register(websocket)

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
  dg.handleMessage = (data) => {
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0]
      if (alt?.transcript && socket.readyState === 1) {
        socket.send(JSON.stringify({
          transcript: alt.transcript,
          is_final: data.is_final,
        }))
      }
    }
  }

  dg.handleClose = () => {
    if (socket.readyState === 1) socket.close()
  }

  dg.handleError = (err) => app.log.error('[STT] ' + (err?.message ?? err))

  // Browser audio → Deepgram
  socket.on('message', (chunk) => {
    if (isOpen(dg)) dg.sendMedia(chunk)
  })

  socket.on('close', () => {
    if (isOpen(dg)) dg.socket.close()
  })

  socket.on('error', (err) => app.log.error('[WS] ' + err.message))
})

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
