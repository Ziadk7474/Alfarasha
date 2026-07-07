/* Al Farasha Al Khadhra — Sales Ledger
   Service Worker: caches the app shell (this file, manifest, icons) so the
   app installs as a real PWA and opens instantly, AND caches the external
   scripts it depends on (jsPDF, Firebase SDK, Google Fonts) so the whole
   app — including entering new sales/payments/dispatch offline — keeps
   working with zero signal. Firebase's own realtime traffic is left
   completely alone; the app itself queues any writes made offline and
   syncs them automatically the moment the connection returns. */

const CACHE_NAME = 'afk-sales-ledger-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

const RUNTIME_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Naskh+Arabic:wght@400;500;600;700&family=Noto+Nastaliq+Urdu:wght@400;600;700&display=swap'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(url => cache.add(url).catch(() => {})));
    await Promise.all(RUNTIME_ASSETS.map(url =>
      fetch(url, { mode: 'no-cors' }).then(res => cache.put(url, res)).catch(() => {})
    ));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app')) return;

  const isSameOrigin = url.origin === self.location.origin;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('./index.html')) || (await cache.match('./'));
      }
    })());
    return;
  }

  if (isSameOrigin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => cache.match(req).then(hit => {
        const network = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || network;
      }))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache => cache.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req, { mode: 'no-cors' })
        .then(res => { cache.put(req, res.clone()); return res; })
        .catch(() => hit);
    }))
  );
});
