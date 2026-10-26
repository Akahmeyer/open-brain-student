// ============================================================================
// OPEN BRAIN — MCP SERVER
// ============================================================================
// MCP (Model Context Protocol) is an open standard that lets AI assistants use
// tools. This function is a small MCP server: an AI sends it a request like
// "search thoughts for marketing", this code asks your database, and sends the
// answer back. The AI never touches the database directly — only this code does.
//
// HOW THE CONVERSATION WORKS: every message is JSON in a format called
// JSON-RPC 2.0. Each request has a "method" (what the AI wants) and "params"
// (the details). The ones an AI sends us:
//   initialize   — "hello, what are you?"          → we describe this server
//   tools/list   — "what can you do?"              → we list our tools
//   tools/call   — "run this tool with these args" → we run it and answer
//   ping         — "are you still there?"          → we say yes
//
// THE TOOLS:
//   search_thoughts — find thoughts containing some words
//   list_recent     — the newest thoughts
//   get_thought     — the full text of one thought (search results are
//                     shortened, so long YouTube transcripts don't flood the AI)
//   add_thought     — save a new thought
//
// SECURITY: this function is deployed with --no-verify-jwt, because Claude
// Desktop can't log in to Supabase. So the function guards itself: every
// request must carry your MCP_ACCESS_KEY, or it is turned away before anything
// else happens.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

// --- Secrets ----------------------------------------------------------------
// You added MCP_ACCESS_KEY in Level 4. OWNER_USER_ID is the same one your
// Telegram bot uses (Level 3) — it says whose thoughts these are.
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// These two are provided automatically by Supabase — you never set them.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service role key skips your database security rules entirely. That is
// why every query below filters by OWNER_USER_ID by hand.
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

const SERVER_INFO = { name: 'open-brain', version: '1.0.0' }

// MCP protocol versions this server understands. If the AI asks for one of
// these we agree to it; otherwise we offer the newest one we know.
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

// Long thoughts (like video transcripts) are shortened in search and list
// results to about this many characters. get_thought returns the full text.
const PREVIEW_CHARS = 1500

// --- CORS -------------------------------------------------------------------
// Lets browser-based MCP tools call this server too. Claude Desktop doesn't
// need it, but it does no harm.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// --- Password check ---------------------------------------------------------
// Compares the two keys in a way that takes the same time whether the first
// character is wrong or the last one is, so an attacker can't guess the key
// one character at a time by measuring how fast we say no.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  }
  return diff === 0
}

function isAuthorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  return MCP_ACCESS_KEY !== '' && safeEqual(token, MCP_ACCESS_KEY)
}

// --- Tool descriptions ------------------------------------------------------
// This is what the AI reads to decide when and how to use each tool. Clear
// descriptions here make the AI noticeably better at using your brain.
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'Open Brain'): notes, ideas, " +
      'YouTube transcripts, articles, PDFs and Telegram messages they saved. Returns up to ' +
      '10 thoughts that contain ALL of the given words, newest first. Use short keywords ' +
      '(1-3 words) and try several searches with different words if the first finds little.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "pricing" or "sleep habits"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: "List the most recently saved thoughts in the user's Open Brain, newest first.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (1-50). Default 10.' },
      },
    },
  },
  {
    name: 'get_thought',
    description:
      'Get the full, untruncated text of one thought by its id. Use this when a search or ' +
      'list result was shortened and you need the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The thought id from a search or list result' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to " +
      'save, remember or capture something.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to save' },
      },
      required: ['content'],
    },
  },
]

// --- Formatting results -----------------------------------------------------
type Thought = {
  id: string
  content: string
  created_at: string
  metadata: Record<string, unknown> | null
}

// Shorten long text. If we know what was searched for, keep the part around
// the first match so the AI sees why this thought came up.
function preview(content: string, words: string[] = []): { text: string; truncated: boolean } {
  if (content.length <= PREVIEW_CHARS) return { text: content, truncated: false }
  const lower = content.toLowerCase()
  const hit = words.length ? lower.indexOf(words[0].toLowerCase()) : -1
  const start = hit > PREVIEW_CHARS / 3 ? hit - Math.floor(PREVIEW_CHARS / 3) : 0
  const slice = content.slice(start, start + PREVIEW_CHARS)
  return { text: (start > 0 ? '…' : '') + slice + '…', truncated: true }
}

function shape(t: Thought, words: string[] = []) {
  const p = preview(t.content, words)
  const meta = t.metadata ?? {}
  return {
    id: t.id,
    created_at: t.created_at,
    source: meta.source ?? null, // e.g. youtube, url, pdf, telegram
    title: meta.title ?? null,
    content: p.text,
    ...(p.truncated
      ? { note: `Shortened from ${t.content.length} characters. Call get_thought with this id for the full text.` }
      : {}),
  }
}

// MCP tools answer with a list of "content" blocks. We send one text block
// holding the results as readable JSON.
function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// --- The tools themselves ---------------------------------------------------
async function runTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'search_thoughts': {
      const query = String(args.query ?? '').trim()
      if (!query) return toolError('Please give a query to search for.')

      // Split into words and require every word to appear somewhere.
      // "pricing strategy" finds "our strategy for pricing" too.
      const words = query.split(/\s+/).filter(Boolean).slice(0, 8)
      let q = db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', OWNER_USER_ID)
      for (const w of words) {
        // % and _ are wildcards in ilike — escape them so they match literally
        q = q.ilike('content', '%' + w.replace(/[\\%_]/g, '\\$&') + '%')
      }
      const { data, error } = await q.order('created_at', { ascending: false }).limit(10)
      if (error) throw error
      if (!data.length) return toolResult({ query, results: [], tip: 'No matches. Try fewer or different words.' })
      return toolResult({ query, count: data.length, results: data.map((t) => shape(t, words)) })
    }

    case 'list_recent': {
      const n = Number(args.limit ?? 10)
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 50) : 10
      const { data, error } = await db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return toolResult({ count: data.length, results: data.map((t) => shape(t)) })
    }

    case 'get_thought': {
      const id = String(args.id ?? '').trim()
      if (!/^[0-9a-f-]{36}$/i.test(id)) return toolError('That does not look like a thought id.')
      const { data, error } = await db
        .from('thoughts')
        .select('id, content, created_at, metadata')
        .eq('user_id', OWNER_USER_ID)
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      if (!data) return toolError('No thought with that id.')
      return toolResult(data)
    }

    case 'add_thought': {
      const content = String(args.content ?? '').trim()
      if (!content) return toolError('Nothing to save: content is empty.')
      const { data, error } = await db
        .from('thoughts')
        .insert({ content, user_id: OWNER_USER_ID, metadata: { source: 'mcp' } })
        .select('id, content, created_at, metadata')
        .single()
      if (error) throw error
      return toolResult({ saved: true, thought: data })
    }

    default:
      return null // unknown tool — handled by the caller
  }
}

// --- Handling one JSON-RPC message -----------------------------------------
// Returns the reply to send, or null for "notifications" (messages without an
// id), which by the rules of JSON-RPC never get a reply.
type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

async function handle(msg: RpcMessage) {
  const isNotification = msg.id === undefined || msg.id === null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : fail(-32600, 'Invalid request')
  }
  if (isNotification) return null // e.g. "notifications/initialized" — nothing to say back

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "This is the user's personal knowledge base. Search it whenever their question might " +
          'relate to something they have saved, and mention which saved thoughts you used.',
      })
    }

    case 'ping':
      return reply({})

    case 'tools/list':
      return reply({ tools: TOOLS })

    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      try {
        const result = await runTool(name, args)
        if (!result) return fail(-32602, `Unknown tool: ${name}`)
        return reply(result)
      } catch (err) {
        // Database errors go back to the AI as a failed tool call, so it can
        // tell you what went wrong instead of the whole connection breaking.
        console.error(`open-brain-mcp: ${name} failed:`, err)
        const message = err instanceof Error ? err.message : JSON.stringify(err)
        return reply(toolError(`The ${name} tool failed: ${message}`))
      }
    }

    default:
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}

// --- The front door ---------------------------------------------------------
Deno.serve(async (req) => {
  // Browsers ask "am I allowed to call you?" first. Say yes.
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

  // Lock: no correct key, no entry. This runs before anything else.
  if (!MCP_ACCESS_KEY) {
    console.error('MCP_ACCESS_KEY secret is not set — refusing every request')
    return json({ error: 'Server is missing its MCP_ACCESS_KEY secret' }, 500)
  }
  if (!isAuthorized(req)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401)
  }

  // This server only answers POSTs. Some MCP clients try GET to open a
  // live stream; 405 tells them politely "not here, just use POST".
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { ...corsHeaders, Allow: 'POST, OPTIONS' } })
  }

  if (!OWNER_USER_ID) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Server is missing its OWNER_USER_ID secret' } }, 500)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read the request as JSON' } }, 400)
  }

  // A request can be one message or a list of them. Handle both.
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handle))).filter(Boolean)
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: corsHeaders })
  }
  const result = await handle(body as RpcMessage)
  return result ? json(result) : new Response(null, { status: 202, headers: corsHeaders })
})
