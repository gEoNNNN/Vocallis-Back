const VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Bella — voce caldă, funcționează în RO + RU

/**
 * Converts text to speech using ElevenLabs.
 * @param {string} text  - Text to synthesize (max 5000 chars)
 * @param {string} lang  - 'ro' (default) | 'ru'
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function generateSpeech(text, lang = 'ro') {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in environment')

  const modelId = lang === 'ru' ? 'eleven_multilingual_v2' : 'eleven_flash_v2_5'

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability:         0.65,
          similarity_boost:  0.85,
          style:             0.15,
          use_speaker_boost: true,
        },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ElevenLabs ${res.status}: ${err}`)
  }

  return Buffer.from(await res.arrayBuffer())
}
