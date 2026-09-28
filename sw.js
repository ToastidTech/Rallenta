/* Rallenta service worker — offline-first app shell. Never touches IndexedDB user data. */
'use strict';
const CACHE = 'rallenta-shell-v9';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'data.js',
  'logic.js',
  'charts.js',
  'player.js',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'audio/manifest.json'
];
// Audio tracks are cached when present; the audio worker may not have built them yet.
const AUDIO = [
  'audio/rain-bed-rallenta-v1.mp3',
  'audio/ambient-pad-rallenta-v2.mp3',
  'audio/spatial-8d-rallenta-v2.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of [...SHELL, ...AUDIO]) {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { /* missing optional asset (e.g. audio not built yet) — skip */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('rallenta-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave GA4 + other third parties to the network
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('index.html', res.clone());
        return res;
      } catch (e) {
        return (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const res = await fetch(request);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
