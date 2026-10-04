/* Service worker: makes the page work offline after the first visit, and adds
 * the two headers GitHub Pages can't send (COOP/COEP) so the page becomes
 * cross-origin isolated and can use the fast multi-threaded converter.
 * Everything the page loads is same-origin, so require-corp costs nothing. */

const VERSION = 'dd6e8d6d314d';
const SHELL_CACHE = `shell-${VERSION}`;
const CORE_CACHE = 'core-ffmpeg-0.12.10'; // immutable: the path changes if the core does

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'i18n.js',
  'plan.js',
  'engine.js',
  'engine-worker.js',
  'converter.js',
  'browser-decode.js',
  'amv.js',
  'screen.js',
  'card.js',
  'save.js',
  'preview.js',
  'device.js',
  'manifest.webmanifest',
  'img/icon.svg',
  'fonts/fraunces-latin.woff2',
  'fonts/atkinson-latin.woff2',
];

// Small engine scripts, fetched only when a conversion starts: cache them up
// front so a visitor who never converted can still convert offline later.
const CORE_SCRIPTS = [
  'vendor/ffmpeg-0.12.10-st/ffmpeg-core.js',
  'vendor/ffmpeg-0.12.10-mt/ffmpeg-core.js',
  'vendor/ffmpeg-0.12.10-mt/ffmpeg-core.worker.js',
];

const scopePath = new URL(self.registration.scope).pathname;

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL.map(async (path) => {
      try {
        if (await cache.match(path)) return;
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (res.ok) await cache.put(path, res);
      } catch (_) {
        // offline: network-first fills it in later
      }
    })
  );
  const core = await caches.open(CORE_CACHE);
  await Promise.all(
    CORE_SCRIPTS.map(async (path) => {
      const url = new URL(path, self.registration.scope).href;
      try {
        if (await core.match(url)) return;
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (res.ok) await core.put(url, res);
      } catch (_) {}
    })
  );
}

// Take over at once: the page reloads into cross-origin isolation as soon
// as this worker controls it, so nothing here waits on the network.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, CORE_CACHE]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
  // Offline copies fill in the background; every page fetch also caches.
  precache().catch(() => {});
});

function isolate(response, { revalidate = false } = {}) {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  // GitHub Pages says max-age=600; left alone, the browser would reuse page
  // files from memory for 10 minutes without asking us, and a visitor could
  // run half old, half new code right after an update. Always ask.
  if (revalidate) headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok && request.method === 'GET') cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) || (request.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CORE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;
  if (request.headers.has('range')) return; // let the browser handle partial requests
  const vendor = url.pathname.includes('/vendor/');
  event.respondWith((vendor ? cacheFirst : networkFirst)(request).then((res) => isolate(res, { revalidate: !vendor })));
});
