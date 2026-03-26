const CACHE_NAME = 'polla-v2.2';
const ASSETS = [
    '/',
    '/index.html',
    '/js/ui.js',
    '/js/auth.js',
    '/js/grupos.js',
    '/js/stats.js',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isInternal = url.origin === self.location.origin;

    if (isInternal) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
    }
});
