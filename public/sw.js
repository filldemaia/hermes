/* Hermes — Service Worker (PWA)
 * Estratègia: cap agressiva. Sempre es demana a la xarxa primer per a navegacions
 * i assets; la cache només serveix d'auxiliar (offline/velocitat), mai provoca
 * que els usuaris vegin versions antigues.
 */
const VERSION = 'hermes-v27';
const CORE = [
  '/',
  '/style.css?v=35',
  '/app.js?v=34',
  '/manifest.webmanifest',
  '/assets/caduceus.svg?v=29',
  '/icon-192.png?v=26',
  '/icon-512.png?v=26',
  '/icon-maskable-192.png?v=26',
  '/icon-maskable-512.png?v=26',
  '/apple-touch-icon.png?v=26',
  '/favicon.ico?v=18',
  '/favicon-32.png?v=18',
  '/favicon-16.png?v=18'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => Promise.allSettled(CORE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // No intervenir en peticions d'API ni de streaming
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/stream') ||
      url.pathname.startsWith('/media') ||
      url.pathname.startsWith('/video')) {
    return;
  }

  // Navegació (SPA): primer xarxa per no servir HTML antic; si falla, cache.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() =>
          caches.match('/').then((cached) => cached || caches.match(event.request))
        )
    );
    return;
  }

  // Fitxers estàtics: cache-first amb revalidació en segon pla.
  // Com que el `.v=` canvia en cada desplegament, mai se serveix una versió vella.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
