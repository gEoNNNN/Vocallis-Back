import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { createSTTConnection, isOpen } from './stt.js'

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

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
