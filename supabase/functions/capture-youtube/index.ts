// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link in your app, and the spoken transcript is saved to
// your brain — no copying and pasting.
//
// WHY THIS FILE LOOKS COMPLICATED — worth understanding before changing it:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre, which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code; it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. It fetches from home internet
//                    connections, so it gets real transcripts. Free tier
//                    covers ~100 videos/month. If you have no key, we skip
//                    straight to route 2.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the
//                    iPhone and Android apps, which YouTube often serves
//                    properly even from a datacentre. No key needed.
//   3. DESCRIPTION — if no captions can be had anywhere, fall back to the
//                    video's description so you still capture something.
//                    Clearly labelled as such, so you're never fooled.
//
// NO SUMMARY YET: summarising needs an AI key you get in Level 5. For now the
// transcript is saved as-is, and Level 5's enrichment agent summarises it.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPADATA_KEY = (Deno.env.get('SUPADATA_API_KEY') ?? '').trim() // optional

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

interface VideoContent {
  text: string
  hasTranscript: boolean
  via: 'supadata' | 'innertube' | 'description'
}

// Turn &amp; &#39; and friends back into normal characters
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
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

// ---------------------------------------------------------------------------
// Pull the 11-character video id out of any YouTube link shape
// ---------------------------------------------------------------------------
function extractVideoId(input: string): string | null {
  const s = input.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  const m = s.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  )
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Title via oEmbed — lightweight, no key, essentially always works
// ---------------------------------------------------------------------------
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return data.title as string
    }
  } catch { /* fall through to placeholder */ }
  return `YouTube video ${videoId}`
}

// ---------------------------------------------------------------------------
// ROUTE 1 — Supadata
// ---------------------------------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) {
    console.log('[youtube] No SUPADATA_API_KEY — skipping to Innertube')
    return null
  }

  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(25_000) },
    )
    if (!res.ok) {
      // 401 = key is wrong. 402/429 = free monthly quota is spent.
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }

    // With text=true, content is one string. Older responses send an array
    // of { text } segments — handle both.
    const data = await res.json()
    const content = data?.content
    const transcript = (
      typeof content === 'string'
        ? content
        : Array.isArray(content)
        ? content.map((s: { text?: string }) => s?.text ?? '').join(' ')
        : ''
    ).replace(/\s+/g, ' ').trim()

    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { text: transcript, hasTranscript: true, via: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// ROUTE 2 — Innertube (YouTube's internal app API), with ROUTE 3 built in
//
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// full caption list even from a datacentre, where the normal web page would
// give us nothing. If no captions come back, the same response still carries
// the description, which becomes route 3.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type PlayerResponse = any

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '17.5.1.21F90', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip',
      context: {
        clientName: 'ANDROID', clientVersion: '19.29.37',
        androidSdkVersion: 34, osName: 'Android', osVersion: '14', hl: 'en', gl: 'US',
      },
    },
  ]

  let best: PlayerResponse = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }

      const result: PlayerResponse = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response around — even without captions it carries
      // the description, which is better than nothing
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        tracks.find((t: PlayerResponse) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t: PlayerResponse) => t.languageCode === 'en') ??
        tracks.find((t: PlayerResponse) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })

      if (capRes.ok) {
        const xml = await capRes.text()
        // Captions arrive as XML, one line per tag, in one of two shapes:
        //   <text start="1.2" dur="3.4">words here</text>
        //   <p t="1200" d="3400"><s>words</s><s> here</s></p>
        const transcript = [...xml.matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g)]
          .map((m) => decodeEntities(decodeEntities(m[2].replace(/<[^>]+>/g, ''))))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { text: transcript, hasTranscript: true, via: 'innertube' }
        }
        console.log('[youtube] Innertube caption file came back empty')
      } else {
        console.log(`[youtube] Innertube caption file HTTP ${capRes.status}`)
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(', ') ?? ''
    if (description || keywords) {
      const text = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { text, hasTranscript: false, via: 'description' }
    }

    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Identify the caller from their login token. We never trust a user id
    // sent in the request body — that would let anyone write into anyone
    // else's brain.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { data: { user }, error: authError } = await userClient.auth.getUser(token)
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube link is required' }, 400)

    const videoId = extractVideoId(url)
    if (!videoId) {
      return json({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order — first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return json({
        ok: false,
        error:
          'Could not read anything from that video. It may be private, age-restricted, ' +
          'or region-locked. You can still paste the transcript in by hand.',
      }, 422)
    }

    // Same shape as the manual YouTube capture in your app, plus a clear
    // label when all we could get was the description
    const label = result.hasTranscript
      ? ''
      : '(No transcript was available — this is the video description.)\n\n'
    const content = `📹 YouTube: ${title}\n${videoUrl}\n\n${label}${result.text}`

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

    // Save the thought — a plain insert, same as your app does
    const { data: thought, error: saveError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: {
          source: 'youtube',
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: result.hasTranscript,
          fetched_via: result.via,
        },
      })
      .select('id')
      .single()
    if (saveError) throw saveError

    // Keep the full transcript (or description) in its own table too. If this
    // part fails, the thought is already saved, so only warn — same rule as
    // Level 2.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: result.text,
      source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: result.text.length,
      truncated: false,
    })
    if (sourceError) console.warn('[youtube] Thought saved, but its source text was not:', sourceError.message)

    return json({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.via,
      chars: result.text.length,
    })
  } catch (err) {
    console.error('[youtube] Failed:', err)
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
    return json({ ok: false, error: msg }, 500)
  }
})
