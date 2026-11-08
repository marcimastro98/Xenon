'use strict';

// ── A word from Bit when something from the Store has an update ─────────────
//
// What the person installed from the Store falls behind when a new version is
// published. The Store says so (the Installed tab, the count on its buttons and
// in the Xenon menu), but only to someone who looks. This files one of Bit's
// messages (js/bit-messages.js) naming the update, with a button to the
// Installed tab, where every update has its key. It replaces a toast that came
// and went once a day.
//
//   * Once a session, after the page has settled: one catalog read (cached by the
//     server) joined by CommunityGallery.findUpdates, the join the Store and the
//     menu count use, so the three never disagree.
//   * A Store widget updates by itself (server/widget-auto-update.js: two days
//     after its catalog date, never with a new permission). It is left to that
//     for three days; one still behind after them is waiting for the person.
//   * One message for the whole list, its id made from the list: a new update is
//     a new message, and an unread one gives way to the fresher list. A list with
//     nothing the person has not read about already is not told again
//     (server/bit-messages.js keeps that rule).
(function () {
  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  const DAY = 24 * 3600 * 1000;
  const AUTO_KINDS = ['widget', 'ambient'];
  const AUTO_WINDOW_MS = 3 * DAY;
  const NAMES_SHOWN = 3;
  const NAME_MAX = 60;
  const FIRST_LOOK_MS = 25000;            // after catalog-drop.js's look, so the two catalog reads do not race
  const LOOK_EVERY_MS = 30 * 60 * 1000;   // until the session's one check has reached the server
  const K_SESSION = 'xeneonedge.storeUpdateMailSession';

  const settings = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
  const base = () => (typeof SERVER === 'string' ? SERVER : '');

  // Short, and the same on every screen that computes it from the same list.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  }

  // Will the automatic updater still take it? Its switch, its kinds and its date
  // (planUpdates() there); a version it cannot date, it never takes.
  function autoTakes(entry, now, s) {
    if (s.autoUpdateWidgets === false || s.safeMode === true) return false;
    if (!AUTO_KINDS.includes(entry.kind) || !entry.pkgId) return false;
    const day = Date.parse(String(entry.updatedAt || entry.addedAt || '') + 'T00:00:00Z');
    return Number.isFinite(day) && now < day + AUTO_WINDOW_MS;
  }

  function plain(text) {
    const rt = window.Xenon && window.Xenon.richText;
    const words = typeof text === 'string' ? text : '';
    return (rt ? rt.plain(words) : words).trim();
  }

  // The message for these updates, or null when there are none. Catalog text
  // goes in as text: the inbox rebuilds it and every screen draws it as text.
  function messageFor(updates) {
    const list = (Array.isArray(updates) ? updates : []).filter((e) => e && e.id && e.version);
    if (!list.length) return null;
    const stamps = list.map((e) => e.id + '@' + e.version).sort();
    const names = list.map((e) => String(e.name || e.id).slice(0, NAME_MAX));
    const msg = { id: 'updates:' + hash(stamps.join('|')), kind: 'updates', stamps, action: { type: 'installed', label: t('bm_installed_open') } };
    if (list.length === 1) {
      const notes = plain(list[0].changelog);
      msg.title = t('settings_updates_toast_one').replace('{name}', names[0]);
      msg.line = notes ? window.BitMessages.firstLine(notes) : t('gallery_fact_version') + ' ' + list[0].version;
      msg.body = notes;
      return msg;
    }
    const more = list.length > NAMES_SHOWN ? ' +' + (list.length - NAMES_SHOWN) : '';
    msg.title = t('settings_updates_toast_n').replace('{n}', String(list.length));
    msg.line = names.slice(0, NAMES_SHOWN).join(', ') + more;
    msg.body = names.join(', ');
    return msg;
  }

  // True once the server has the answer, whatever it was.
  async function check() {
    const G = window.CommunityGallery;
    const BM = window.BitMessages;
    if (!G || typeof G.findUpdates !== 'function' || !BM) return false;
    let cat = null;
    try { cat = await (await fetch(base() + '/api/community/catalog')).json(); } catch { return false; }
    if (!cat || !cat.ok || !Array.isArray(cat.entries)) return false;   // offline: the next look
    const now = Date.now();
    const s = settings();
    const updates = (await G.findUpdates(cat.entries)).filter((e) => e && !autoTakes(e, now, s));
    const msg = messageFor(updates);
    return BM.file(msg ? [msg] : [], { updates: msg ? [msg.id] : [] });
  }

  window.StoreUpdateMail = Object.freeze({ messageFor, autoTakes, check });

  // A layer window shows no messages; the alerts window of "widgets only" does.
  if (window.BitMessages && window.BitMessages.surface !== 'screen' && typeof isLayerPage === 'function' && isLayerPage()) return;
  const sessionDone = () => { try { return sessionStorage.getItem(K_SESSION) === '1'; } catch { return false; } };
  const look = async () => {
    if (sessionDone()) return;
    try {
      if (await check()) sessionStorage.setItem(K_SESSION, '1');
    } catch { /* best-effort: the next look tries again */ }
  };
  const loop = () => setTimeout(() => { if (sessionDone()) return; look(); loop(); }, LOOK_EVERY_MS);
  setTimeout(() => { look(); loop(); }, FIRST_LOOK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
})();
