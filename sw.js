/* Al Farasha Al Khadhra — Sales Ledger
   Service Worker: caches the app shell (this file, manifest, icons) so the
   app installs as a real PWA and opens instantly, AND caches the external
   scripts it depends on (jsPDF, Firebase SDK, Google Fonts) so the whole
   app — including entering new sales/payments/dispatch offline — keeps
   working with zero signal. Firebase's own realtime traffic is left
   completely alone; the app itself queues any writes made offline and
   syncs them automatically the moment the connection returns. */

const CACHE_NAME = 'afk-sales-ledger-v3';

/* Firebase Realtime DB URL, passed by the app when registering:
   sw.js?db=<encoded URL>. Used for the closed-app overdue check below. */
const DB_URL = (() => {
  try { return decodeURIComponent(new URL(self.location).searchParams.get('db') || ''); }
  catch (e) { return ''; }
})();

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

/* ══════════ DAILY OVERDUE CHECK (runs even when the app is closed) ══════════
   Periodic Background Sync fires this on installed PWAs roughly every
   12–24h (the browser decides exact timing). It reads sales + customers
   straight from Firebase REST, applies the same due-date logic as the app
   (invoice date + customer's credit days), and posts WhatsApp-style
   notifications: customer name as title, invoice/amount as the preview. */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'overdue-daily') event.waitUntil(checkOverduesAndNotify());
});

/* Tapping a notification opens/focuses the app. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow('./');
    })
  );
});

async function checkOverduesAndNotify() {
  if (!DB_URL) return;
  try {
    const [salesRes, custRes, payRes] = await Promise.all([
      fetch(DB_URL + '/sales.json'),
      fetch(DB_URL + '/customers.json'),
      fetch(DB_URL + '/payments.json')
    ]);
    const salesObj = await salesRes.json() || {};
    const custObj = await custRes.json() || {};
    const payObj = await payRes.json() || {};
    const sales = Object.values(salesObj);
    const payments = Object.values(payObj);
    const custMap = {};
    Object.values(custObj).forEach(c => { if (c && c.id) custMap[c.id] = c; });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const fmtAED = n => 'AED ' + (Math.round(n * 100) / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const alerts = [];

    for (const s of sales) {
      if (!s) continue;
      const bal = Math.round(((Number(s.total) || 0) - (Number(s.paidAmount) || 0)) * 100) / 100;
      if (bal <= 0.004) continue;
      const c = custMap[s.customerId];
      if (!c || c.isCashSale) continue;
      const due = new Date((s.date || '') + 'T00:00:00');
      if (isNaN(due)) continue;
      due.setDate(due.getDate() + (Number(c.creditDays) || 0));
      if (due < today) {
        const overdueDays = Math.round((today - due) / 86400000);
        alerts.push({
          title: c.nameUr && c.nameUr.trim() ? c.nameUr : (c.nameEn || 'Customer'),
          body: `Invoice ${s.invoiceNo || ''} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} past the ${Number(c.creditDays) || 0}-day limit — ${fmtAED(bal)} outstanding. Follow up for payment.`,
          tag: 'overdue-' + (s.id || s.invoiceNo)
        });
      }
    }

    // Credit-limit breaches — balance matches the app: opening + all sales − all payments
    const balances = {};
    for (const s of sales) { if (s && s.customerId) balances[s.customerId] = (balances[s.customerId] || 0) + (Number(s.total) || 0); }
    for (const p of payments) { if (p && p.customerId) balances[p.customerId] = (balances[p.customerId] || 0) - (Number(p.amount) || 0); }
    Object.values(custMap).forEach(c => {
      if (!c.creditLimit || c.creditLimit <= 0 || c.isCashSale) return;
      const bal = Math.round(((balances[c.id] || 0) + (Number(c.opening) || 0)) * 100) / 100;
      if (bal > Number(c.creditLimit) + 0.004) {
        alerts.push({
          title: c.nameUr && c.nameUr.trim() ? c.nameUr : (c.nameEn || 'Customer'),
          body: `Credit limit exceeded — outstanding ${fmtAED(bal)} vs limit ${fmtAED(Number(c.creditLimit))}. Follow up for payment.`,
          tag: 'credit-' + c.id
        });
      }
    });

    if (alerts.length === 0) return;
    const show = alerts.slice(0, 5);
    for (const a of show) {
      await self.registration.showNotification(a.title, {
        body: a.body, tag: a.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' }
      });
    }
    if (alerts.length > 5) {
      await self.registration.showNotification('Al Farasha — Payment follow-ups', {
        body: alerts.length + ' customers need follow-up today. Open the app to review.',
        tag: 'overdue-summary', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' }
      });
    }
  } catch (e) { /* offline or DB unreachable — next sync will retry */ }
        }
