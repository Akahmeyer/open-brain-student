// Network first, cached copy as a fallback. Your brain's data (saving,
// searching, logging in) always goes straight to Supabase and is never cached.
const CACHE = 'open-brain-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', () => self.clients.claim())

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./')))
  )
})
