// Open Brain — Telegram bot
//
// Telegram calls this function (the "webhook") every time someone messages
// your bot. Depending on the message, it saves a thought, searches your
// thoughts, or lists recent ones, then replies in Telegram.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Secrets — read from Supabase's secrets manager, never written in this file
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_ALLOWED_CHAT_ID') ?? ''
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''

// These two are provided automatically by Supabase
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service role key skips your security rules entirely. That's why every
// query below filters by OWNER_USER_ID by hand — nothing else will do it.
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const HELP = [
  '🧠 Open Brain',
  '',
  'Just type anything — I save it as a thought.',
  '',
  '/search coffee — find thoughts containing "coffee"',
  '?coffee — same thing, shorter',
  '/recent — your last 5 thoughts',
].join('\n')

// Always answer Telegram with 200 OK, even on errors. Anything else makes
// Telegram think delivery failed, and it keeps retrying the same message.
function ok() {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000), // Telegram's limit is 4096 characters
      disable_web_page_preview: true,
    }),
  })
  if (!res.ok) console.error('Telegram sendMessage failed:', res.status, await res.text())
}

function formatThoughts(rows: { content: string; created_at: string }[]) {
  return rows
    .map((r, i) => {
      const text = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      return `${i + 1}. ${text}\n   — ${date}`
    })
    .join('\n\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return ok()
  if (req.method !== 'POST') return ok()

  // Lock 1: if a webhook secret is set, only accept requests carrying it.
  // Telegram attaches it to every delivery; a stranger guessing your URL can't.
  if (WEBHOOK_SECRET && req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    console.warn('Rejected a request without the correct webhook secret')
    return ok()
  }

  let chatId: number | undefined
  try {
    const update = await req.json()
    const message = update.message
    const text: string | undefined = message?.text?.trim()
    chatId = message?.chat?.id

    // Photos, stickers, voice notes, edited messages — ignored for now
    if (!chatId || !text) return ok()

    // Lock 2: only YOUR chat. Until you've set TELEGRAM_ALLOWED_CHAT_ID, the
    // bot just tells you your chat ID so you can add it. It saves nothing.
    if (!ALLOWED_CHAT_ID) {
      await reply(
        chatId,
        `👋 Almost set up!\n\nYour chat ID is: ${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets with the name ' +
          'TELEGRAM_ALLOWED_CHAT_ID, then message me again.\n\nNothing was saved.',
      )
      return ok()
    }
    if (String(chatId) !== ALLOWED_CHAT_ID) {
      console.warn('Ignored a message from an unknown chat:', chatId)
      return ok() // stay silent to strangers
    }

    if (!OWNER_USER_ID) {
      await reply(chatId, '⚠️ The OWNER_USER_ID secret is missing in Supabase. Nothing was saved.')
      return ok()
    }

    const lower = text.toLowerCase()

    // /start and /help
    if (lower.startsWith('/start') || lower.startsWith('/help')) {
      await reply(chatId, HELP)
      return ok()
    }

    // /search something  or  ?something
    if (lower.startsWith('/search') || text.startsWith('?')) {
      const term = text.startsWith('?')
        ? text.slice(1).trim()
        : text.replace(/^\/search(@\w+)?/i, '').trim()
      if (!term) {
        await reply(chatId, 'What should I search for? Try: /search coffee')
        return ok()
      }
      // % and _ are wildcards in ilike — escape them so they match literally
      const pattern = '%' + term.replace(/[\\%_]/g, '\\$&') + '%'
      const { data, error } = await db
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', pattern)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId,
        data.length
          ? `🔎 ${data.length} result${data.length === 1 ? '' : 's'} for "${term}":\n\n${formatThoughts(data)}`
          : `Nothing found for "${term}".`,
      )
      return ok()
    }

    // /recent
    if (lower.startsWith('/recent')) {
      const { data, error } = await db
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId,
        data.length ? `🕒 Your last ${data.length}:\n\n${formatThoughts(data)}` : 'Your brain is empty so far.',
      )
      return ok()
    }

    // Any other /command is probably a typo — don't save it as a thought
    if (text.startsWith('/')) {
      await reply(chatId, "I don't know that command.\n\n" + HELP)
      return ok()
    }

    // Everything else: save it as a new thought, owned by you
    const { error } = await db.from('thoughts').insert({
      content: text,
      user_id: OWNER_USER_ID,
      metadata: { source: 'telegram', telegram_message_id: message.message_id },
    })
    if (error) throw error
    await reply(chatId, '✅ Saved to your brain')
  } catch (err) {
    console.error('telegram-bot error:', err)
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    if (chatId) await reply(chatId, '⚠️ Something went wrong: ' + msg).catch(() => {})
  }

  return ok()
})