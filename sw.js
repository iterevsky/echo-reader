/* ЭХО: Service Worker. BUILD_ID меняется при выпуске обновления оболочки. */
const BUILD_ID = 'echo-shell-2026-11-25-v6';
const SHELL_CACHE = `echo-shell-${BUILD_ID}`;
const META_CACHE = 'echo-meta-v1';
const BOOTSTRAP_CACHE = 'echo-content-bootstrap-v1';
const CONTENT_CACHE_PREFIX = 'echo-content-';

const scopeUrl = self.registration.scope;
const activeMarkerUrl = new URL('__echo__/active-content.json', scopeUrl).href;
const coreFiles = [
  'index.html',
  'manifest.webmanifest',
  'styles/install.css',
  'scripts/core/install.js',
  'assets/icons/favicon-v6.svg',
  'assets/icons/icon-v6-192.png',
  'assets/icons/icon-v6-512.png',
  'assets/icons/icon-v6-maskable-512.png',
  'assets/icons/icon-v6-maskable-192.png',
  'assets/icons/apple-touch-v6.png',
  'styles/base.css',
  'styles/contents.css',
  'styles/reader.css',
  'styles/offline.css',
  'scripts/core/app.js',
  'scripts/core/storage.js',
  'scripts/core/offline.js',
  'scripts/screens/contents.js',
  'scripts/screens/reader.js',
  'data/chapters.json',
  'data/chapters-manifest.json',
  'assets/images/splash-original.png'
];

function url(path) {
  return new URL(path, scopeUrl).href;
}

function isWithinScope(requestUrl) {
  return requestUrl.origin === new URL(scopeUrl).origin && requestUrl.pathname.startsWith(new URL(scopeUrl).pathname);
}

async function getActiveContentCache() {
  try {
    const meta = await caches.open(META_CACHE);
    const marker = await meta.match(activeMarkerUrl);
    if (!marker) return null;
    const data = await marker.json();
    if (!data?.version || !/^[a-f0-9]{20}$/.test(data.version)) return null;
    return caches.open(`${CONTENT_CACHE_PREFIX}${data.version}`);
  } catch {
    return null;
  }
}

async function getShellResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  return cache.match(request, { ignoreSearch: true });
}

async function getExpectedChapter(request, activeCache) {
  const manifestUrl = url('data/chapters-manifest.json');
  let response = activeCache ? await activeCache.match(manifestUrl) : null;
  if (!response) response = await getShellResponse(new Request(manifestUrl));
  if (!response) return null;

  try {
    const manifest = await response.json();
    const relativePath = new URL(request.url).pathname.slice(new URL(scopeUrl).pathname.length);
    return manifest.chapters?.find((item) => item.file === relativePath) || null;
  } catch {
    return null;
  }
}

async function isVerifiedChapter(response, item) {
  if (!response || !item) return false;
  try {
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength !== item.bytes) return false;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    return actual === item.sha256;
  } catch {
    return false;
  }
}

async function respondWithContent(request, event) {
  const activeCache = await getActiveContentCache();
  const bootstrapCache = await caches.open(BOOTSTRAP_CACHE);
  const expected = await getExpectedChapter(request, activeCache);

  if (!expected) {
    return new Response('Глава отсутствует в проверенном манифесте.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  if (activeCache) {
    const activeResponse = await activeCache.match(request, { ignoreSearch: true });
    if (activeResponse && await isVerifiedChapter(activeResponse, expected)) {
      return activeResponse;
    }
    if (activeResponse) await activeCache.delete(request);
  }

  const bootstrapResponse = await bootstrapCache.match(request, { ignoreSearch: true });
  if (bootstrapResponse && await isVerifiedChapter(bootstrapResponse, expected)) {
    return bootstrapResponse;
  }
  if (bootstrapResponse) await bootstrapCache.delete(request);

  try {
    const networkResponse = await fetch(request);
    if (!networkResponse.ok) return networkResponse;

    if (!await isVerifiedChapter(networkResponse, expected)) {
      return new Response('Файл главы не прошёл проверку целостности. Старый кеш не заменён.', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const targetCache = activeCache || bootstrapCache;
    event.waitUntil(targetCache.put(request, networkResponse.clone()).catch(() => {}));
    return networkResponse;
  } catch {
    return new Response('Эта глава ещё не сохранена для офлайн-чтения.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function respondWithVersionedData(request) {
  const activeCache = await getActiveContentCache();
  if (activeCache) {
    const response = await activeCache.match(request, { ignoreSearch: true });
    if (response) return response;
  }

  const shellResponse = await getShellResponse(request);
  if (shellResponse) return shellResponse;

  try {
    const response = await fetch(request);
    if (response.ok && activeCache) {
      await activeCache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response('Каталог ещё не сохранён для офлайн-режима.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const requests = coreFiles.map((file) => new Request(url(file), { cache: 'reload' }));
    await cache.addAll(requests);
    // После полной загрузки оболочки не ждём закрытия всех вкладок.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const shellKeys = keys
      .filter((key) => key.startsWith('echo-shell-'))
      .sort()
      .reverse();
    const keep = new Set(shellKeys.slice(0, 2));
    keep.add(SHELL_CACHE);
    await Promise.all(shellKeys
      .filter((key) => !keep.has(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Страница сверяет версию контроллера со своей версией перед безопасным обновлением.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ECHO_GET_BUILD' && event.ports[0]) {
    event.ports[0].postMessage({ build: BUILD_ID });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (!isWithinScope(requestUrl)) return;

  // Только менеджер обновлений использует этот заголовок, чтобы получить свежий файл из сети.
  if (request.headers.has('X-Echo-Network-Only')) return;

  const pathname = requestUrl.pathname;
  const chapterMarker = `${new URL('data/chapters/', scopeUrl).pathname}`;
  const catalogPath = new URL('data/chapters.json', scopeUrl).pathname;
  const manifestPath = new URL('data/chapters-manifest.json', scopeUrl).pathname;

  if (pathname.startsWith(chapterMarker) && pathname.endsWith('.html')) {
    event.respondWith(respondWithContent(request, event));
    return;
  }

  if (pathname === catalogPath || pathname === manifestPath) {
    event.respondWith(respondWithVersionedData(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await getShellResponse(new Request(url('index.html')));
      if (cached) return cached;
      return fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await getShellResponse(request);
    if (cached) return cached;
    return fetch(request);
  })());
});
