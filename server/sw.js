/* Xenon service worker — served from the ROOT (`GET /sw.js`) so its scope is the
   whole dashboard. A worker under /public/ could only ever control /public/.

   This exists for ONE reason: a browser will not let a page be installed as an
   app without it. That makes it a liability more than a feature, because a
   service worker's natural behaviour — serve from cache, update later — is
   exactly wrong for a dashboard whose entire content is live data and whose code
   is replaced by a self-update. A stale cached bundle after an update would be
   invisible, would survive a reload, and would look like Xenon breaking itself.

   So the rules here are deliberately timid:

   - NETWORK FIRST, always. The cache is only ever consulted when the network
     actually failed. Nothing is ever served from cache while the PC is reachable,
     so a self-update lands on the next reload exactly as it does today.
   - Only same-origin GETs, and only for the SHELL: the document and the static
     assets under the directories server.js serves. Anything that carries live
     state or acts on the PC (/api/*, /sse, /settings, /actions/*, /sdk/*, every
     non-GET) is passed straight through and never stored — a cached answer there
     would be a lie about the machine.
   - The cache name carries the app version, and `activate` deletes every cache
     that is not the current one. An update therefore drops the whole previous
     shell rather than merging with it.
   - No precache and no skipWaiting on install: nothing is fetched that the page
     did not ask for, and a worker never takes over a tab mid-session.

   What the user gets: the app opens from the home screen with its own icon, and
   when the PC is off it shows Xenon's own "cannot reach your PC" shell instead of
   the browser's error page. That is the whole promise — it is not an offline
   dashboard, because there is no such thing. */

'use strict';

// Replaced by the route in server.js at serve time, so a new Xenon version means
// a new cache name and a clean sweep on activate.
const VERSION = '__XENON_VERSION__';
const CACHE = 'xenon-shell-' + VERSION;

// Only these prefixes are ever stored. It is the same list server.js serves as
// static files — if a new asset directory is added there, add it here or it
// simply will not be available offline (which is a degradation, never a fault).
const SHELL_PREFIXES = ['/js/', '/styles/', '/components/', '/vendor/', '/public/', '/shared/', '/assets/'];

// Never cached, whatever else matches: these describe or change the PC.
const NEVER = [
  '/api/', '/sse', '/settings', '/actions/', '/sdk/', '/deck', '/status', '/system',
  '/media', '/audio', '/volume', '/network', '/notes', '/tasks', '/events', '/timers',
  '/weather', '/windows', '/search', '/update', '/pair', '/toggle', '/mic',
];

function isShell(url) {
  if (NEVER.some((p) => url.pathname === p || url.pathname.startsWith(p))) return false;
  return SHELL_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('install', () => {
  // No precache: the page is about to request everything it needs anyway, and a
  // precache list is a second copy of the asset graph that goes stale silently.
  // No skipWaiting either — a worker that takes over a running tab can serve it
  // a different version of the code than the one it booted with.
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('xenon-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch a mutation
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;        // fonts, R2, the catalog

  // The document itself: network first, and the last good copy only when the
  // network is gone. `credentials: 'include'` is not needed — a navigation
  // carries the pairing cookie by itself.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Only a real 200 is worth keeping. A 401/302 to /pair is a moment in
        // time, and caching it would strand the app on the pairing page.
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const c = await caches.open(CACHE);
          c.put('/', fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        const hit = await caches.match('/');
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  if (!isShell(url)) return;                              // pass through untouched

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});

// ── Push (T2c) ───────────────────────────────────────────────────────────────
//
// This is the only part of this worker that is a feature rather than a
// requirement. The payload arrives encrypted end to end (see server/web-push.js)
// and the browser has already decrypted it by the time it gets here.
//
// A push event MUST end in a visible notification. Every browser enforces this:
// a worker woken by a push that shows nothing gets its push permission revoked
// after a few tries, silently. So the catch below is not defensive tidiness —
// showing SOMETHING on a malformed payload is what keeps the feature alive.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const title = typeof d.title === 'string' && d.title ? d.title : 'Xenon';
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === 'string' ? d.body : '',
    tag: typeof d.tag === 'string' && d.tag ? d.tag : 'xenon',
    // Replace rather than stack: a second notification for the same timer is
    // the same notification, and a lock screen full of them is how a user turns
    // the whole feature off.
    renotify: true,
    icon: '/public/images/logo/logo-mark.png',
    badge: '/public/images/logo/logo-mark.png',
    data: { url: typeof d.url === 'string' ? d.url : '/' },
  }));
});

// Tapping one focuses the dashboard that is already open rather than opening a
// second copy of it — an app that spawns a new window every time it is tapped
// is an app with six windows by lunchtime.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        // navigate() can reject (a client that is not controlled yet); focusing
        // is the part that matters, so a failed navigate must not lose it.
        if ('navigate' in c) await c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// The escape hatch. A service worker that misbehaves is very hard for a user to
// get rid of — this lets the page tell it to remove itself and every cache it
// made, so "turn it off and reload" is an action Xenon can offer rather than a
// DevTools procedure.
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'xenon-unregister') return;
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('xenon-shell-')).map((n) => caches.delete(n)));
    await self.registration.unregister();
  })());
});
