/* WebRadio PWA service worker: app shell offline, live API/audio always network. */
const CACHE = 'webradio-v3';
const SHELL = [
    'index.html',
    'admin.html',
    'pub.html',
    'stats.html',
    'alarm.html',
    'style.css',
    'app.js',
    'admin.js',
    'pub.js',
    'stats.js',
    'alarm.js',
    'covermap.js',
    'leaflet.js',
    'leaflet.css',
    'site.webmanifest',
    'radio.svg',
    'favicon-32x32.png',
    'favicon-16x16.png',
    'apple-touch-icon.png',
    'android-chrome-192x192.png',
    'android-chrome-512x512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const path = new URL(event.request.url).pathname;
    // Live endpoints bypass the cache entirely (streams, control API).
    if (path.includes('/api/') || path.includes('/audio/')) return;
    event.respondWith(
        caches.match(event.request).then((hit) => {
            if (hit) return hit;
            return fetch(event.request).then((res) => {
                if (res && (res.status === 200 || res.type === 'opaque')) {
                    const copy = res.clone();
                    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
                }
                return res;
            }).catch(() => caches.match('index.html'));
        })
    );
});
