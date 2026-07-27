// Service worker — Elikia Lecture
// met en cache l'app shell + les bibliothèques de lecture (epub.js/pdf.js)
// pour un fonctionnement garanti hors-ligne après le premier chargement.
// Les fichiers de livres eux-mêmes sont stockés dans IndexedDB par l'app (pas ici).

const CACHE_VERSION = 'biblio-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/splash-1170x2532.png',
  './icons/splash-1284x2778.png',
  './icons/splash-1125x2436.png',
  './icons/splash-828x1792.png',
  './icons/splash-1179x2556.png',
  './vendor/jszip.min.js',
  './vendor/epub.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/fonts/OpenDyslexic-Regular.woff',
  './vendor/fonts/OpenDyslexic-Bold.woff',
  './vendor/fonts/OpenDyslexic-Italic.woff',
  './vendor/fonts/OpenDyslexic-BoldItalic.woff',
  './vendor/fonts/opendyslexic.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie : cache-first pour l'app shell et les CDN externes (epub.js, pdf.js, polices),
// avec repli réseau + mise en cache à la volée pour tout le reste.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
            const resClone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
