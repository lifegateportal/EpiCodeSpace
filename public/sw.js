const SHELL_CACHE = 'epicodespace-shell-v1';
const RUNTIME_CACHE = 'epicodespace-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const network = await fetch(event.request);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(event.request, network.clone()).catch(() => {});
        return network;
      } catch {
        const cachedPage = await caches.match(event.request);
        if (cachedPage) return cachedPage;
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) {
      fetch(event.request)
        .then(async (network) => {
          const cache = await caches.open(RUNTIME_CACHE);
          await cache.put(event.request, network.clone());
        })
        .catch(() => {});
      return cached;
    }

    try {
      const network = await fetch(event.request);
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(event.request, network.clone()).catch(() => {});
      return network;
    } catch {
      return cached || Response.error();
    }
  })());
});
