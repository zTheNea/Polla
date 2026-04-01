const CACHE_NAME = 'polla-v3.2';
const ASSETS = [
    '/',
    '/index.html',
    '/js/ui.js',
    '/js/auth.js',
    '/js/grupos.js',
    '/js/stats.js',
    '/js/chat.js',
    '/js/ranking.js',
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        })
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isInternal = url.origin === self.location.origin;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Solo cachar respuestas válidas (no errores de 3ros)
                if(!response || response.status !== 200 || response.type !== 'basic' && response.type !== 'cors') {
                    return response;
                }
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
