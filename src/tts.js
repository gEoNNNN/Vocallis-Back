import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * Converts text to speech using OpenAI TTS.
 * @param {string} text - Text to synthesize
 * @param {string} voice - OpenAI voice name (alloy, echo, fable, onyx, nova, shimmer)
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function generateSpeech(text, voice = 'nova') {
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
    response_format: 'mp3',
  })
  return Buffer.from(await response.arrayBuffer())
}
