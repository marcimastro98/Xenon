// Installable app (T2b) — registers the service worker and nothing else.
//
// The whole point is the HOME SCREEN: on a phone reached over HTTPS, Xenon gets
// its own icon and opens without the browser's address bar, which is the
// difference between "a page I bookmarked" and "the app on my tablet". A
// browser will not offer that without a manifest AND a service worker, so
// sw.js exists to satisfy a requirement rather than because a dashboard wants a
// cache — see the long note at the top of it for how timid it deliberately is.
//
// Where this deliberately does NOTHING:
//   - the LAN door (plain HTTP) is not a secure context, so there is nothing to
//     register and the browser would refuse anyway;
//   - the native app already IS an app — a worker inside WebView2 would be a
//     second caching layer under a shell that has its own updater;
//   - any iframe (the iCUE widget, a `?panel=` embed, the Edge preview stage):
//     those are surfaces INSIDE something else and must never install anything.
(function () {
  'use strict';

  function suppressed() {
    if (typeof window === 'undefined') return true;
    if (!('serviceWorker' in navigator)) return true;
    // 127.0.0.1 counts as secure, so this passes on the PC too — which is
    // correct: the desktop browser can install Xenon as well.
    if (!window.isSecureContext) return true;
    if (window.__XENON_NATIVE__ === true || window.isTauri === true) return true;
    try { if (window.top !== window.self) return true; } catch { return true; }  // cross-origin parent
    if (/[?&]panel=/.test(location.search)) return true;
    return false;
  }

  function register() {
    if (suppressed()) return;
    // Registration failing is not worth a word to the user: everything on the
    // page works without it, and the only consequence is that the browser does
    // not offer to install. Logged, because a silent no-op is how a feature
    // becomes impossible to diagnose later.
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((e) => console.warn('[pwa] service worker not registered:', e && e.message));
  }

  // The escape hatch, reachable from the console and from any future settings
  // button. A service worker the user cannot get rid of is the worst failure
  // mode this file could have, so removing it is a supported action rather than
  // a DevTools procedure: it tells the worker to drop its caches (it knows their
  // names), then unregisters every registration under our scope.
  async function unregister() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg && reg.active) reg.active.postMessage({ type: 'xenon-unregister' });
      const all = await navigator.serviceWorker.getRegistrations();
      await Promise.all(all.map((r) => r.unregister()));
      return true;
    } catch (e) { console.warn('[pwa] unregister failed:', e && e.message); return false; }
  }

  // ── Push (T2c) ─────────────────────────────────────────────────────────────
  //
  // Notifications are the last thing the plain-HTTP door cannot do, and the
  // only Xenon feature that sends anything to a company that is not the user.
  // So the rules here are stricter than anywhere else on this page:
  //
  //   - nothing happens until the user asks. `enable()` is called from a button
  //     and from nowhere else. There is no "ask on the third visit" prompt: a
  //     permission dialog the user did not summon is how a site gets denied
  //     permanently, and a denial cannot be undone from a page.
  //   - the permission request happens INSIDE the user's click. Browsers
  //     require the gesture, and an await before it can lose it.
  //   - resubscribing on every load is deliberate: a push endpoint is rotated
  //     by the browser whenever it likes, and a subscription the server still
  //     holds after a rotation is an address that will never ring again.

  const b64uToBytes = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };

  const pushSupported = () => !suppressed() && 'PushManager' in window && 'Notification' in window;

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('http_' + res.status);
    return res.json();
  }

  /** The live subscription for THIS browser, or null. */
  async function current() {
    if (!pushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch { return null; }
  }

  /**
   * Turn notifications on for this device. Returns a reason rather than a
   * boolean, because every failure here has a different thing the user has to
   * do about it and a bare false leaves the UI guessing.
   */
  async function enable() {
    if (!pushSupported()) return { ok: false, reason: 'unsupported' };
    // Inside the gesture: no await before this line.
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: perm === 'denied' ? 'denied' : 'dismissed' };
    try {
      let reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const { key } = await api('/api/push/key');
      if (!key) return { ok: false, reason: 'no_key' };
      // An existing subscription made against a DIFFERENT server key can never
      // be delivered to, and the browser refuses to re-subscribe over it — so
      // it has to go first. This is the case after a data-dir reset.
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        const same = new Uint8Array(existing.options.applicationServerKey || new ArrayBuffer(0));
        const want = b64uToBytes(key);
        if (same.length !== want.length || !same.every((b, i) => b === want[i])) await existing.unsubscribe();
      }
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      const r = await api('/api/push/subscribe', { subscription: sub.toJSON() });
      return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || 'refused' };
    } catch (e) {
      console.warn('[pwa] push subscribe failed:', e && e.message);
      return { ok: false, reason: 'failed' };
    }
  }

  /** Off for this device: the browser forgets it AND the PC forgets it. */
  async function disable() {
    const sub = await current();
    if (!sub) return { ok: true };
    const endpoint = sub.endpoint;
    // Order matters: tell the server first. If the browser drops it first and
    // the call then fails, the PC keeps an address that can never be cleaned up
    // from this side again — the endpoint is gone from here.
    try { await api('/api/push/unsubscribe', { endpoint }); } catch { /* try anyway */ }
    try { await sub.unsubscribe(); } catch { /* already gone */ }
    return { ok: true };
  }

  /** What the settings panel needs to draw the row honestly. */
  async function pushState() {
    if (!pushSupported()) {
      return { supported: false, permission: 'default', subscribed: false, secure: !!window.isSecureContext };
    }
    const sub = await current();
    let known = false;
    if (sub) {
      try {
        const res = await fetch('/api/push/status', { headers: { 'X-Xenon-Endpoint': sub.endpoint } });
        known = res.ok ? ((await res.json()).subscribed === true) : false;
      } catch { known = false; }
    }
    return {
      supported: true,
      permission: Notification.permission,
      // Subscribed means BOTH sides agree. A browser that still holds a
      // subscription the PC has dropped (a revoked device) is not subscribed,
      // and saying it is would leave the user waiting for a notification that
      // is never coming.
      subscribed: !!sub && known,
      secure: !!window.isSecureContext,
    };
  }

  async function test(title, body) {
    try { return await api('/api/push/test', { title, body }); }
    catch (e) { return { ok: false, error: e && e.message }; }
  }

  // Keep the stored endpoint fresh. Only when the user has already opted in —
  // this must never be the thing that CREATES a subscription.
  async function refresh() {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await current();
    if (!sub) return;
    try { await api('/api/push/subscribe', { subscription: sub.toJSON() }); } catch { /* offline */ }
  }

  // After load: registration competes with the 100+ scripts this page already
  // runs serially, and nothing on screen depends on it.
  function boot() { register(); setTimeout(refresh, 4000); }
  if (document.readyState === 'complete') setTimeout(boot, 1200);
  else window.addEventListener('load', () => setTimeout(boot, 1200));

  window.Pwa = { register, unregister, suppressed, enable, disable, pushState, test, pushSupported };
})();
