import OpenAI from 'openai'
import { checkSlot, createBooking } from './calendar.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_slot',
      description:
        'Verifică dacă un slot orar este disponibil în calendar. ' +
        'Apelează această funcție IMEDIAT ce clientul propune o dată și o oră. ' +
        'Nu continua cu colectarea altor date dacă slotul nu e confirmat disponibil.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data în format ISO YYYY-MM-DD (ex: "2026-06-25")',
          },
          time: {
            type: 'string',
            description: 'Ora în format HH:MM 24h (ex: "19:00")',
          },
        },
        required: ['date', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_booking',
      description:
        'Creează rezervarea în Google Calendar. ' +
        'Apelează DOAR după ce ai confirmat TOATE câmpurile: ' +
        'data, ora (disponibilă), numărul de persoane și numele clientului.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data rezervării în format ISO YYYY-MM-DD',
          },
          time: {
            type: 'string',
            description: 'Ora rezervării în format HH:MM',
          },
          guests: {
            type: 'integer',
            description: 'Numărul de persoane',
          },
          customer_name: {
            type: 'string',
            description: 'Numele pe care se face rezervarea',
          },
        },
        required: ['date', 'time', 'guests', 'customer_name'],
      },
    },
  },
]

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('ro-RO', { timeZone: 'Europe/Chisinau' })
  return (
    `Ești "Arina", asistentul vocal de rezervări al restaurantului Casa Verde Bistro din Chișinău.
` +
    `Scopul tău UNIC este să faci rezervări de mese. Colectezi în ordine:
` +
    `1. Data dorită (convertești "mâine", "poimâine", etc. în dată reală — azi e ${today})
` +
    `2. Ora dorită — verifici imediat disponibilitatea cu check_slot
` +
    `3. Numărul de persoane
` +
    `4. Numele pe care se face rezervarea
` +
    `
` +
    `Odată ce ai toate patru câmpuri confirmate și slotul e disponibil, apelezi place_booking.
` +
    `
` +
    `REGULI STRICTE:
` +
    `- Maxim două propoziții per răspuns. O singură întrebare per răspuns.
` +
    `- Orele în formă vorbită: "ora opt seara", "ora douăsprezece și jumătate".
` +
    `- Apelează ÎNTOTDEAUNA check_slot imediat ce clientul propune o oră — nu judeca tu dacă ora e validă sau nu.
` +
    `- Dacă check_slot returnează available=false, spune că ora nu este disponibilă și oferă 2-3 ore din freeSlotsToday în formă vorbită.
` +
    `- Nu comenta niciodată dacă o oră e "în afara programului" fără să fi chemat mai întâi check_slot.
` +
    `- Dacă clientul vorbește rusă, răspunzi imediat în rusă.
` +
    `- Nu vorbi despre altceva în afară de rezervare și informații de bază.
` +
    `- Fără liste sau formatare — ești într-o conversație vorbită.`
  )
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Send a user message to GPT-4o, handle calendar tool calls, return result.
 * @param {Array}  history  - conversation history
 * @param {string} userText - new user utterance
 * @returns {Promise<{ text: string, booking: object|null, historyEntries: Array }>}
 */
export async function askBookings(history, userText) {
  const userMessage = { role: 'user', content: userText }
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    userMessage,
  ]

  let currentMessages = [...messages]
  const extraHistory  = []
  let booking         = null

  // Tool-call loop (GPT may call multiple tools in sequence)
  for (let i = 0; i < 5; i++) {
    const response = await openai.chat.completions.create({
      model:       'gpt-4o',
      messages:    currentMessages,
      tools:       TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens:  512,
    })

    const choice = response.choices[0]

    // ── Plain text response ────────────────────────────────────────────────
    if (choice.finish_reason !== 'tool_calls') {
      const text = choice.message.content
      return {
        text,
        booking,
        historyEntries: [
          userMessage,
          ...extraHistory,
          { role: 'assistant', content: text },
        ],
      }
    }

    // ── Tool call response ─────────────────────────────────────────────────
    const assistantMsg   = choice.message
    const toolResults    = []

    for (const toolCall of assistantMsg.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments)
      let result

      try {
        if (toolCall.function.name === 'check_slot') {
          console.log('[BOOKINGS] check_slot:', args)
          result = await checkSlot(args.date, args.time)
          console.log('[BOOKINGS] slot result:', result)

        } else if (toolCall.function.name === 'place_booking') {
          console.log('[BOOKINGS] place_booking:', args)
          const calResult = await createBooking(args)
          booking = { ...args, id: calResult.bookingId, ...calResult }
          result  = { success: true, ...booking }
          console.log('[BOOKINGS] booking created:', booking)
        }
      } catch (toolErr) {
        console.error('[BOOKINGS] tool error:', toolErr.message)
        result = { error: toolErr.message, available: true }
      }

      toolResults.push({
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      JSON.stringify(result),
      })
    }

    extraHistory.push(assistantMsg, ...toolResults)
    currentMessages = [...currentMessages, assistantMsg, ...toolResults]
  }

  // Fallback if loop exhausted
  const fallback = 'Îmi pare rău, a apărut o problemă. Vă rog să reîncercați.'
  return {
    text: fallback,
    booking,
    historyEntries: [userMessage, ...extraHistory, { role: 'assistant', content: fallback }],
  }
}
