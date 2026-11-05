'use strict';

const CACHE = 'dompet-fleksibel-v3';
const SHELL = ['./', './index.html', './app.js?v=4', './manifest.json', './icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // tambahkan satu per satu agar satu file gagal tidak membatalkan semuanya
      Promise.all(SHELL.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** File aplikasi: ambil dari jaringan dulu (selalu versi terbaru); bila lambat >3 detik atau offline, pakai cache. */
function networkFirst(req) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => caches.match(req).then(finish), 3000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      finish(res);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(req)
        .then(c => c || (req.mode === 'navigate' ? caches.match('./index.html') : null))
        .then(c => { if (!done) { done = true; resolve(c || Response.error()); } });
    });
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API Google Apps Script: selalu langsung ke jaringan, jangan di-cache
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  if (url.origin === self.location.origin) { event.respondWith(networkFirst(req)); return; }

  // CDN (Tailwind, Google Fonts): cache saat pertama dipakai, lalu tersedia offline
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
