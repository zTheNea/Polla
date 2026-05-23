const CACHE_NAME = 'polla-v3.6';
const ASSETS = [
    '/?v=3.6',
    '/index.html?v=3.6',
    '/js/ui.js?v=3.6',
    '/js/auth.js?v=3.6',
    '/js/grupos.js?v=3.6',
    '/js/stats.js?v=3.6',
    '/js/chat.js?v=3.6',
    '/js/ranking.js?v=3.6'
];

// CDNs ya no se pre-cachean para evitar servir versiones obsoletas
// Se cachearán dinámicamente con network-first

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
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
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isInternal = url.origin === self.location.origin;

    // NUNCA cachear llamadas a la API ni WebSockets
    if (isInternal && url.pathname.startsWith('/api/')) return;
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Solo cachear respuestas válidas
                if(!response || response.status !== 200) {
                    return response;
                }
                // Solo cachear recursos internos y CDNs conocidos
                if (response.type === 'basic' || response.type === 'cors') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
