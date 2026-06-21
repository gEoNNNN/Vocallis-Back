import OpenAI from 'openai'
import { KNOWLEDGE_BASE } from './knowledge-base.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Order ID counter ───────────────────────────────────────────────────────────
let orderCounter = 0

function generateOrderId() {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  orderCounter += 1
  return `CVB-${date}-${String(orderCounter).padStart(3, '0')}`
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: 'Plasează o comandă la Casa Verde Bistro. Apelează DOAR când ai colectat preparatele dorite, tipul comenzii și numele clientului.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'string',
            description: 'Lista preparatelor și băuturilor comandate (ex: "Burger Casa Verde + Limonadă naturală")',
          },
          order_type: {
            type: 'string',
            enum: ['local', 'livrare'],
            description: 'Tipul comenzii: local (la masă în restaurant) sau livrare la domiciliu',
          },
          address: {
            type: 'string',
            description: 'Adresa de livrare (obligatorie pentru livrare, “N/A” pentru local)',
          },
          customer_name: {
            type: 'string',
            description: 'Numele clientului',
          },
        },
        required: ['items', 'order_type', 'address', 'customer_name'],
      },
    },
  },
]

// ── Order processing ───────────────────────────────────────────────────────────
function processOrder(args) {
  const order = {
    id: generateOrderId(),
    items: args.items,
    order_type: args.order_type,
    address: args.address ?? 'N/A',
    customer_name: args.customer_name,
    timestamp: new Date().toISOString(),
  }
  console.log('[ORDER PLACED]', JSON.stringify(order, null, 2))
  return { success: true, ...order }
}

// ── System prompt ──────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `Ești un asistent vocal pentru restaurantul Casa Verde Bistro. Preiei comenzi de mâncare și băutură prin conversație vocală.

REGULI:
1. Răspunde EXCLUSIV la comenzi și întrebări despre meniu și restaurant.
2. Nu inventa preparate care nu sunt în meniu.
3. Răspunde ÎNTOTDEAUNA în română.
4. Textul poate conține erori de transcriere — interpretează intenția.
5. Fii concis și prietenos. Maxim două propoziții per răspuns.

FLUX COMANDĂ:
Colectează prin întrebări succinte:
1. Ce preparate și băuturi doresc (din meniu)
2. Tipul comenzii: local (la masă) sau livrare
3. Dacă livrare: adresa de livrare completă
4. Numele clientului
Când ai toate câmpurile confirmate, apelează place_order. Nu apela funcția înainte.
Pentru comenzi locale, folosește “N/A” la câmpul address.

${KNOWLEDGE_BASE}`
}

// ── Main assistant function ────────────────────────────────────────────────────
/**
 * Sends a user message to GPT-4o, handles any tool calls, and returns the result.
 * @param {Array} history - conversation history (may include tool call entries)
 * @param {string} userText - the new user message
 * @returns {Promise<{ text: string, order: object|null, historyEntries: Array }>}
 */
export async function askAssistant(history, userText) {
  const userMessage = { role: 'user', content: userText }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    userMessage,
  ]

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.2,
    max_tokens: 512,
  })

  const choice = response.choices[0]

  // ── Normal response (no tool call) ──────────────────────────────────────────
  if (choice.finish_reason !== 'tool_calls') {
    const text = choice.message.content
    return {
      text,
      order: null,
      historyEntries: [
        userMessage,
        { role: 'assistant', content: text },
      ],
    }
  }

  // ── Tool call response ───────────────────────────────────────────────────────
  const assistantToolMsg = choice.message
  let order = null
  const toolResultMessages = []

  for (const toolCall of assistantToolMsg.tool_calls) {
    if (toolCall.function.name === 'place_order') {
      const args = JSON.parse(toolCall.function.arguments)
      order = processOrder(args)
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(order),
      })
    }
  }

  // Second call: GPT-4o generates the spoken confirmation
  const finalResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [...messages, assistantToolMsg, ...toolResultMessages],
    temperature: 0.2,
    max_tokens: 512,
  })

  const finalText = finalResponse.choices[0].message.content

  return {
    text: finalText,
    order,
    historyEntries: [
      userMessage,
      assistantToolMsg,
      ...toolResultMessages,
      { role: 'assistant', content: finalText },
    ],
  }
}
