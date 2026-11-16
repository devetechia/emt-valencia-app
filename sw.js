/* Service worker — rutas relativas: funciona igual en local y en GitHub Pages */
const VERSION = 'emt-val-2026-11-15w';

const CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/map.js',
  './js/drive.js',
  './js/quiz.js',
  './js/app.js',
  './manifest.json',
  './icon.svg',
];

const DATA = [
  './data/lines.json',
  './data/stops.json',
  './data/transform.json',
  './data/meta.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const path = url.pathname;
  const isMap = path.endsWith('/map.json');
  const isData = DATA.some(d => path.endsWith(d.replace('./', '')));
  const isCore = CORE.some(c =>
    (c === './' && (path.endsWith('/') || path.endsWith('/index.html'))) ||
    (c !== './' && path.endsWith(c.replace('./', ''))));

  // 1) el plano grande (3 MB): caché primero, revalidación en segundo plano
  if (isMap) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        const net = fetch(e.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 2) datos y código: red primero, caché como respaldo (así se actualiza
  //    siempre al desplegar, y sigue funcionando sin conexión)
  if (isData || isCore) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(h => h || Response.error()))
    );
    return;
  }

  // 3) resto: red con respaldo en caché
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
