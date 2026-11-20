// Service worker:
// 1) кэширует приложение — работает офлайн;
// 2) добавляет заголовки COOP/COEP — включает crossOriginIsolated,
//    без которого браузер не даёт SharedArrayBuffer многопоточному Stockfish
//    (GitHub Pages сам такие заголовки ставить не умеет).
const CACHE = 'chessbot-v3';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/board.js', 'js/engine.js', 'js/vision.js', 'js/pieces.js', 'vendor/chess.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const heavy = url.pathname.includes('/engine/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (heavy) {
      // движок большой и не меняется — сначала кэш
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    }
    // остальное — сначала сеть (чтобы обновления приходили сразу), офлайн — из кэша
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return isolate(hit);
      throw err;
    }
  })());
});
