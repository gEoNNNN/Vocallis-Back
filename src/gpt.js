import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * Sends a user message to GPT and streams chunks via onChunk callback.
 * @param {string} userText - The transcribed user speech
 * @param {function} onChunk - Called with each text delta chunk
 * @param {Array} history - Conversation history [{role, content}]
 */
export async function askGPT(userText, onChunk, history = []) {
  const messages = [
    ...history,
    { role: 'user', content: userText },
  ]

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    stream: true,
  })

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) onChunk(delta)
  }
}
