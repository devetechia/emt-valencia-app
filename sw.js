const CACHE_NAME = 'emt-valencia-v1';
const FILES_TO_CACHE = [
    '/emt-valencia-app/',
    '/emt-valencia-app/index.html',
    '/emt-valencia-app/manifest.json',
    '/emt-valencia-app/sw.js',
    '/emt-valencia-app/icon.svg'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(FILES_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(response => {
            if (response) {
                return response;
            }
            return fetch(event.request);
        }).catch(() => {
            if (event.request.method === 'GET' && event.request.headers.get('accept').includes('text/html')) {
                return caches.match('/emt-valencia-app/index.html');
            }
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});