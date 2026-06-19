import { DeepgramClient } from '@deepgram/sdk'

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY })

/**
 * Creează și deschide o conexiune live STT Deepgram.
 * Handlers disponibili pe socket: onMessage(data), onClose(), onError(err)
 * @param {object} opts - opțiuni opționale
 * @returns {Promise<object>} socket gata de utilizat
 */
export async function createSTTConnection(opts = {}) {
  // createConnection() returnează un Promise în SDK v5
  const conn = await deepgram.listen.v1.createConnection({
    model: 'nova-3',
    language: 'ro',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1500,
    endpointing: 300,
    punctuate: true,
    vad_events: true,
    encoding: 'linear16',
    sample_rate: 16000,
    ...opts,
  })

  // Conectează și așteaptă deschiderea
  await new Promise((resolve, reject) => {
    conn.handleOpen  = resolve
    conn.handleError = reject
    conn.connect()
  })

  console.log('[STT] Ready')
  return conn
}

/**
 * Verifică dacă conexiunea Deepgram e deschisă.
 * @param {object} conn - conexiunea returnată de createSTTConnection
 */
export function isOpen(conn) {
  return conn?.socket?.readyState === 1
}
