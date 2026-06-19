import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * Converts text to speech using OpenAI gpt-4o-mini-tts.
 * @param {string} text         - Text to synthesize
 * @param {string} voice        - OpenAI voice name (alloy, echo, fable, onyx, nova, shimmer)
 * @param {string} instructions - Optional voice style instructions
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function generateSpeech(text, voice = 'nova', instructions = '') {
  const params = {
    model: 'gpt-4o-mini-tts',
    voice,
    input: text,
    response_format: 'mp3',
  }
  if (instructions) params.instructions = instructions

  const response = await openai.audio.speech.create(params)
  return Buffer.from(await response.arrayBuffer())
}
