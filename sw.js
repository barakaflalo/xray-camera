/* X·RAY CAM — Service Worker · AppNest
   Lessons applied (requirements v13.1, part 12):
   - per-file caching with allSettled (never atomic addAll)
   - navigation: network-first with ~4s timeout → cache → friendly offline page (never an error)
   - Cloudflare 308 redirect fix: every navigation response is re-wrapped clean
   - skipWaiting so a fixing SW takes over immediately
   - vendor cache (MediaPipe engine + models + fonts) cache-first, so scanning works offline after the first load
   BUMP VERSION ON EVERY RELEASE. */
const VERSION = '1.0.0';
const APP_CACHE = 'xraycam-app-' + VERSION;
const VENDOR_CACHE = 'xraycam-vendor-v1';   // pinned library/model URLs → stable across app versions
const SHELL = ['./', './index.html', './manifest.json', './privacy_policy.html', './icon-192.png', './icon-512.png'];
const VENDOR_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, {status: res.status, statusText: res.statusText, headers: res.headers});
}
// wrapper: any navigation response handed to respondWith is cleaned of the "redirected" flag
const _respondWith = FetchEvent.prototype.respondWith;
FetchEvent.prototype.respondWith = function (p) {
  if (this.request.mode !== 'navigate') return _respondWith.call(this, p);
  return _respondWith.call(this, Promise.resolve(p).then(clean));
};

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_CACHE);
    await Promise.allSettled(SHELL.map(async u => {
      const r = await fetch(u, {cache: 'no-cache'});
      if (r.ok) await c.put(u, await clean(r));
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('xraycam-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const OFFLINE_HTML = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X·RAY CAM</title><body style="margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0b0b0d;color:#f2f0ea;font-family:system-ui,sans-serif;text-align:center;padding:24px">
<div style="font-size:52px">📡</div><h2 style="margin:0">אין חיבור לאינטרנט</h2><p style="color:#a3a097;margin:0">No internet connection. The app will load once you're back online.</p>
<button onclick="location.reload()" style="min-height:48px;padding:0 26px;border-radius:12px;border:1.5px solid #d4af37;background:none;color:#d4af37;font-size:16px;font-weight:700">נסה שוב · Retry</button></body></html>`;

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) navigation: network-first (4s) → cache → offline page
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await Promise.race([fetch(req, {cache: 'no-cache'}), timeout(4000)]);
        if (r && r.ok) { const c = await caches.open(APP_CACHE); c.put('./index.html', (await clean(r)).clone()).catch(() => {}); }
        return r;
      } catch (err) {
        const c = await caches.open(APP_CACHE);
        const hit = (await c.match('./index.html')) || (await c.match('./')) || (await caches.match(req));
        return hit || new Response(OFFLINE_HTML, {headers: {'Content-Type': 'text/html; charset=utf-8'}});
      }
    })());
    return;
  }

  // 2) same-origin files: network-first (no-cache revalidation) → cache fallback
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req, {cache: 'no-cache'});
        if (r.ok) { const c = await caches.open(APP_CACHE); c.put(req, r.clone()).catch(() => {}); }
        return r;
      } catch (err) {
        return (await caches.match(req)) || new Response('', {status: 504});
      }
    })());
    return;
  }

  // 3) pinned vendor files (engine, models, fonts): cache-first
  if (VENDOR_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(VENDOR_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone()).catch(() => {});
      return r;
    })());
    return;
  }
  // 4) anything else: untouched (pass-through)
});
