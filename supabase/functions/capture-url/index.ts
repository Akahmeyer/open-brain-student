// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste an article link in your app. This function fetches the page on the
// server, pulls out the readable text, and saves it to your brain.
//
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// download other websites' pages. That rule is called CORS and it exists for
// good security reasons. A server has no such limit, so the browser hands the
// link to this function and this function does the fetching.
//
// NO SUMMARY YET: summarising needs an AI key you get in Level 5. For now the
// full readable text is saved, and Level 5's enrichment agent summarises it
// later. Nothing is lost by saving the raw text first.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const MAX_BYTES = 3_000_000 // don't try to swallow a 50MB page

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Turn &amp; &#39; &nbsp; and friends back into normal characters
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      try { return String.fromCodePoint(n) } catch { return match }
    }
    return NAMED[code.toLowerCase()] ?? match
  })
}

// HTML -> readable text. Deliberately simple, no external library: strip the
// machinery (scripts, styles, menus, footers), then remove remaining tags.
// Not perfect on every site, but it handles articles and blog posts well.
function htmlToText(html: string): { title: string; text: string } {
  // Title first, before we destroy the markup
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() || 'Untitled page' : 'Untitled page'

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    // Remove whole elements that never contain article content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    // Keep paragraph and heading breaks as newlines so structure survives
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Everything else goes
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Who is asking? Taken from their login token, never from the request
    // body. Trusting a user id sent by the browser would let anyone write
    // into anyone else's brain.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { data: { user }, error: authError } = await userClient.auth.getUser(token)
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A link is required' }, 400)

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return json({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    // Only normal public web pages — never let the server be pointed at
    // internal addresses
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(parsed.hostname)) {
      return json({ ok: false, error: 'That address is not a public web page' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers. Paste the text in by hand instead.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process' }, 413)

    const { title, text } = htmlToText(raw)
    if (text.length < 200) {
      return json({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see. Paste the text in by hand instead.',
      }, 422)
    }

    const finalUrl = pageRes.url || parsed.toString()
    const hostname = new URL(finalUrl).hostname
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

    // Save the thought — a plain insert, same as your app does
    const { data: thought, error: saveError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content: `🔗 ${title}\n${finalUrl}\n\n${text}`,
        metadata: { source: 'url', title, url: finalUrl, hostname },
      })
      .select('id')
      .single()
    if (saveError) throw saveError

    // Keep the full extracted text in its own table too. If this part fails,
    // the thought is already saved, so only warn — same rule as Level 2.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (sourceError) console.warn('[url] Thought saved, but its source text was not:', sourceError.message)

    return json({ ok: true, title, hostname, chars: text.length })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = String(err).includes('timeout')
      ? 'That page took too long to respond.'
      : err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
    return json({ ok: false, error: msg }, 500)
  }
})
