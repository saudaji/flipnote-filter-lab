const CACHE = 'flipnote-filter-lab-v79-audio-engine';
const CDN_CACHE = 'flip-cdn-v1';
const CORE_ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './pretext.js'];
const FONT_ASSETS = [
  './fonts/Bloom-Regular.otf', './fonts/BNMonica.otf', './fonts/Fluidic-Regular.otf', './fonts/Canterbury.ttf'];

self.addEventListener('install', e =>
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(CORE_ASSETS);
      await Promise.allSettled(FONT_ASSETS.map(font => c.add(font)));
    }).then(() => self.skipWaiting())
  )
);

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
);

function isMediaPipeRequest(request) {
  const url = new URL(request.url);
  return (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@mediapipe/')) ||
    (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/'));
}

async function cacheMediaPipe(request) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('./index.html', { ignoreSearch: true }).then(r => r || fetch(e.request)));
    return;
  }
  if (e.request.method === 'GET' && isMediaPipeRequest(e.request)) {
    e.respondWith(cacheMediaPipe(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
