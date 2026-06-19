import OpenAI from 'openai'
import { KNOWLEDGE_BASE } from './knowledge-base.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Order ID counter ───────────────────────────────────────────────────────────
let orderCounter = 0

function generateOrderId() {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  orderCounter += 1
  return `ORD-${date}-${String(orderCounter).padStart(3, '0')}`
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: 'Plasează o comandă pentru un produs TechMD SRL. Apelează această funcție DOAR când ai colectat toate cele trei câmpuri obligatorii: produsul, planul și numele complet al clientului.',
      parameters: {
        type: 'object',
        properties: {
          product: {
            type: 'string',
            enum: ['TechMD CRM', 'TechMD Invoicer', 'TechMD HRM'],
            description: 'Produsul comandat',
          },
          plan: {
            type: 'string',
            enum: ['Start', 'Business', 'Enterprise'],
            description: 'Planul ales',
          },
          customer_name: {
            type: 'string',
            description: 'Numele complet al clientului',
          },
        },
        required: ['product', 'plan', 'customer_name'],
      },
    },
  },
]

// ── Order processing ───────────────────────────────────────────────────────────
function processOrder(args) {
  const order = {
    id: generateOrderId(),
    product: args.product,
    plan: args.plan,
    customer_name: args.customer_name,
    timestamp: new Date().toISOString(),
  }
  console.log('[ORDER PLACED]', JSON.stringify(order, null, 2))
  return { success: true, ...order }
}

// ── System prompt ──────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `Ești un asistent virtual pentru compania TechMD SRL. Răspunzi EXCLUSIV pe baza informațiilor din baza de cunoștințe de mai jos.

REGULI STRICTE:
1. Răspunde DOAR la întrebări despre TechMD SRL și produsele/serviciile sale.
2. Dacă utilizatorul întreabă ceva care NU se regăsește în baza de cunoștințe, răspunde exact: "Îmi pare rău, pot răspunde doar la întrebări despre TechMD SRL."
3. Nu inventa informații care nu sunt în baza de cunoștințe.
4. Răspunde ÎNTOTDEAUNA în limba română.
5. Textul primit poate conține erori de transcriere cauzate de accentul regional (Republica Moldova). Interpretează intenția utilizatorului chiar dacă unele cuvinte sunt transcrise incorect.
6. Fii concis și direct. Răspunsurile să fie practice și utile.

COMENZI:
Dacă utilizatorul dorește să plaseze o comandă (expresii ca "vreau să comand", "aș dori să cumpăr", "vreau să mă abonez", "cumpăr", "comandă" etc.), colectează prin întrebări succinte:
1. Produsul dorit (TechMD CRM, TechMD Invoicer sau TechMD HRM)
2. Planul ales (Start, Business sau Enterprise)
3. Numele complet al clientului
Când ai toate trei informațiile confirmate, apelează funcția place_order. Nu apela funcția înainte de a avea toate câmpurile obligatorii. Dacă clientul corectează o informație anterior furnizată, folosește valoarea corectată.

BAZA DE CUNOȘTINȚE:
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
