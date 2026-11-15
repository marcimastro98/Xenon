'use strict';
// Cross-surface coordination for the dashboard "Browser" widget (GitHub #96).
//
// Each dashboard surface (the desktop browser at 127.0.0.1:3030 and the XENON
// native app) drives its OWN headless Edge page for the same tile — server.js
// namespaces the CDP target per WebSocket connection (tid = connId + ':' +
// localId) precisely so two surfaces of different sizes don't fight over one
// page. But every page shares ONE Edge profile, hence ONE cookie jar. So a login
// completed on one surface writes the session cookie the OTHER surface's page
// needs, yet that page keeps showing the login screen until it reloads — the user
// had to restart the whole app before the stream appeared there too (#96).
//
// This tracks, per logical tile (localId), which surface is on which URL, and
// when one surface navigates away from a shared page it returns the sibling tiles
// that should follow. The caller re-navigates them; cookies are shared, so they
// render the now-authenticated page without a manual reload.
//
// It stays deliberately conservative so an independently-used surface is never
// yanked around:
//   • a sibling follows ONLY if it is on the EXACT same URL the mover just left
//     (the shared "both stuck on the login page" state) — never if it wandered
//     off on its own;
//   • a sibling the user touched within `idleMs` is left alone;
//   • the follow updates the sibling's tracked URL up front, so its own ensuing
//     navigation can't bounce back (no ping-pong);
//   • an explicit user navigation (address bar / back-forward), flagged via
//     markUserNav, updates state but never propagates — only automatic/redirect
//     navigations (how a login actually completes) fan out.
//
// Pure and side-effect-free (it only computes a plan); server.js executes it.
// `now` is injectable for deterministic tests.
function createBrowserSurfaceSync(options) {
  const o = options || {};
  const idleMs = Number.isFinite(o.idleMs) ? o.idleMs : 8000;
  const surfaces = new Map();   // localId -> Map<connId, { tid, url, lastInputAt, suppressNext }>

  function tileMap(localId) {
    let m = surfaces.get(localId);
    if (!m) { m = new Map(); surfaces.set(localId, m); }
    return m;
  }

  // Register a surface's tile when it opens. Idempotent: a re-open on the same
  // connection keeps the tracked URL/input state and just refreshes the tid.
  function open(localId, connId, tid) {
    const m = tileMap(localId);
    const cur = m.get(connId) || { tid, url: '', lastInputAt: 0, suppressNext: false };
    cur.tid = tid;
    m.set(connId, cur);
  }

  // Drop a surface's tile (close or disconnect), and the whole entry once empty.
  function close(localId, connId) {
    const m = surfaces.get(localId);
    if (!m) return;
    m.delete(connId);
    if (m.size === 0) surfaces.delete(localId);
  }

  // The user interacted with (or reloaded) this surface's tile — protect it from
  // being followed for `idleMs`.
  function markInput(localId, connId, at) {
    const m = surfaces.get(localId);
    const st = m && m.get(connId);
    if (st) st.lastInputAt = Number.isFinite(at) ? at : 0;
  }

  // The user explicitly drove this surface somewhere (typed an address, back /
  // forward). Suppress the ONE navigation it triggers from fanning out — a
  // deliberate "I'm going elsewhere" is not a shared-state change to mirror.
  function markUserNav(localId, connId, at) {
    const m = surfaces.get(localId);
    const st = m && m.get(connId);
    if (st) { st.suppressNext = true; st.lastInputAt = Number.isFinite(at) ? at : st.lastInputAt; }
  }

  // Record that a tile navigated to `url` and return the sibling tiles that should
  // follow, as an array of { tid, url }. Automatic/redirect navigations fan out to
  // idle same-URL siblings; a user-flagged navigation only updates state.
  function navigated(localId, connId, url, opts) {
    const at = opts && Number.isFinite(opts.at) ? opts.at : 0;
    const m = surfaces.get(localId);
    if (!m) return [];
    const st = m.get(connId);
    const prevUrl = st ? st.url : '';
    const suppressed = !!(st && st.suppressNext);
    if (st) { st.url = url; st.suppressNext = false; }
    // Nothing to mirror: a user-driven nav, the first load (no prior URL), or a
    // no-op landing on the same URL.
    if (suppressed || !prevUrl || prevUrl === url) return [];
    const plan = [];
    for (const [otherConn, other] of m) {
      if (otherConn === connId) continue;
      if (other.url !== prevUrl) continue;                     // not on the shared page
      if (at - (other.lastInputAt || 0) < idleMs) continue;    // in active use — leave it
      other.url = url;                                         // optimistic → no bounce-back
      plan.push({ tid: other.tid, url });
    }
    return plan;
  }

  return { open, close, markInput, markUserNav, navigated, _surfaces: surfaces };
}

module.exports = { createBrowserSurfaceSync };
