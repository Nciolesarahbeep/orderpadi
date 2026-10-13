// OrderPadi's service worker: shows order alerts on the seller's phone (even
// with the app closed), opens the right screen when one is tapped, and shows
// a friendly page instead of the browser's error when there's no internet.
// It never caches the app itself, so a new version is live on the next open.
const OFFLINE = '/offline.html';
const CACHE = 'op-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Pages come from the network; only when that fails is the offline page shown.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'OrderPadi';
  const options = {
    body: data.body || 'You have something new in OrderPadi.',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/app#notifications' }
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // The number on the app icon (where the phone supports it).
    if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(data.badge); } catch (e) { /* not supported */ }
    }
    // An open app refreshes its bell right away.
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    open.forEach((c) => c.postMessage({ type: 'op-push' }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find((c) => new URL(c.url).pathname.replace(/\.html$/, '') === '/app');
    if (app) {
      app.postMessage({ type: 'op-open', url: target });
      return app.focus();
    }
    return self.clients.openWindow(target);
  })());
});
