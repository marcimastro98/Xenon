'use strict';
// Bit's mail, the store: the letters every promo channel files here instead of
// opening its own popup, and the one rule for when Bit may say "you have mail".
//
// Why a mailbox. Each channel used to interrupt on its own terms: the month's
// drops as a full-screen modal, hub announcements as a modal, the supporter ask
// and the share invitation as corner cards. Interruptions during a task cost
// time and goodwill, and deferring them to a break is what people prefer (Iqbal
// & Bailey, CHI 2008; Mehrotra et al., CHI 2016). News that is not urgent
// belongs in a passive indicator the user opens when they choose (NN/g,
// "Indicators, Validations, and Notifications", 2015). So a channel now posts a
// letter, the mail button shows it is there, and Bit says one sentence about it
// at most once a day, never while a game, a scene, a dialog, a voice session or
// typing is going on.
//
// Letters live in localStorage on this device. They are copies of what the
// channel already had (the catalog, the hub feed): losing them loses nothing.
// Every read is validated, because storage is user-editable and may be stale.
// UMD like interrupt-queue.js: Node gets the factory, a browser also gets the
// live instance on window once the arbiter exists.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object' && typeof document !== 'undefined') {
    root.BitMailCore = api.create();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY = 24 * 3600 * 1000;
  const K_MAIL = 'xeneonedge.bitMail';
  const MAX_LETTERS = 40;
  const KEEP_DAYS = 90;
  const GONE_CAP = 200;
  const TITLE_MAX = 120;
  const LINE_MAX = 240;
  const DATA_MAX = 4096;     // serialized bytes, enough for a hub message with a poll
  const ID_RE = /^[a-z0-9][a-z0-9:_.-]{0,95}$/i;
  const KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;
  // Bit is listening or answering: a note now would talk over it.
  const VOICE_CLASSES = ['ai-voice-mode', 'ai-listening'];
  // Input types that take typed text. A checkbox or a slider is not typing.
  const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

  const cut = (s, max) => String(s).slice(0, max);

  function cleanData(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    try {
      const s = JSON.stringify(d);
      return (s && s.length <= DATA_MAX) ? JSON.parse(s) : {};
    } catch { return {}; }
  }

  function cleanLetter(l, now) {
    if (!l || typeof l !== 'object') return null;
    if (typeof l.id !== 'string' || !ID_RE.test(l.id)) return null;
    if (typeof l.kind !== 'string' || !KIND_RE.test(l.kind)) return null;
    if (typeof l.title !== 'string' || !l.title.trim()) return null;
    const at = Number.isFinite(l.at) ? l.at : now;
    return {
      id: l.id,
      kind: l.kind,
      at,
      read: l.read === true,
      title: cut(l.title.trim(), TITLE_MAX),
      line: typeof l.line === 'string' ? cut(l.line.trim(), LINE_MAX) : '',
      note: typeof l.note === 'string' ? cut(l.note.trim(), LINE_MAX) : '',
      data: cleanData(l.data),
    };
  }

  function create(deps) {
    const d = deps || {};
    const store = d.storage !== undefined ? d.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    const now = d.now || Date.now;
    const arbiter = () => (d.interrupts !== undefined ? d.interrupts : (typeof window !== 'undefined' ? window.XenonInterrupts : null));
    const doc = d.doc !== undefined ? d.doc : (typeof document !== 'undefined' ? document : null);

    // The in-memory copy is the truth for this page; storage is its backup. A
    // blocked storage still shows the letters until the page closes.
    let box = null;

    function load() {
      if (box) return box;
      let raw = null;
      try { raw = store ? JSON.parse(store.getItem(K_MAIL)) : null; } catch { raw = null; }
      const t = now();
      const letters = (raw && Array.isArray(raw.letters) ? raw.letters : [])
        .map((l) => cleanLetter(l, t))
        .filter((l) => l && t - l.at <= KEEP_DAYS * DAY);
      const gone = (raw && Array.isArray(raw.gone) ? raw.gone : []).filter((id) => typeof id === 'string' && ID_RE.test(id));
      box = { letters, gone };
      return box;
    }

    function save() {
      if (!store || !box) return;
      try { store.setItem(K_MAIL, JSON.stringify({ v: 1, letters: box.letters, gone: box.gone })); } catch { /* full/blocked */ }
    }

    function prune() {
      const t = now();
      box.letters = box.letters
        .filter((l) => t - l.at <= KEEP_DAYS * DAY)
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_LETTERS);
      box.gone = box.gone.slice(-GONE_CAP);
    }

    // Files a letter. False when it is already here or the user threw it away:
    // channels re-check every session, and a letter must arrive once.
    function post(letter) {
      load();
      const l = cleanLetter(Object.assign({}, letter, { at: now(), read: false }), now());
      if (!l) return false;
      if (box.gone.includes(l.id) || box.letters.some((x) => x.id === l.id)) return false;
      box.letters.push(l);
      prune();
      save();
      return true;
    }

    function list() { load(); return box.letters.slice().sort((a, b) => b.at - a.at); }
    function get(id) { return load().letters.find((l) => l.id === id) || null; }
    function unread() { return load().letters.filter((l) => !l.read).length; }

    function markRead(id) {
      const l = get(id);
      if (!l || l.read) return;
      l.read = true;
      save();
    }

    function remove(id) {
      load();
      const before = box.letters.length;
      box.letters = box.letters.filter((l) => l.id !== id);
      if (box.letters.length === before) return;
      if (!box.gone.includes(id)) box.gone.push(id);
      prune();
      save();
    }

    function typing() {
      const a = doc && doc.activeElement;
      if (!a) return false;
      if (a.isContentEditable) return true;
      const tag = String(a.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') return true;
      return tag === 'INPUT' && TEXT_INPUTS.has(String(a.type || '').toLowerCase());
    }

    // Not now: the arbiter's busy (games, scenes, the lock screen, any dialog),
    // a voice session, or a caret in a text field.
    function quiet() {
      const I = arbiter();
      if (I && typeof I.busy === 'function' && I.busy()) return true;
      try {
        const c = doc && doc.body && doc.body.classList;
        if (c && VOICE_CLASSES.some((k) => c.contains(k))) return true;
      } catch { return true; }
      return typing();
    }

    // The day's one interruption, from the budget every channel shares.
    function claimNote() {
      const I = arbiter();
      return !!(I && typeof I.claimDaily === 'function' && I.claimDaily('bit-mail'));
    }

    return { post, list, get, unread, markRead, remove, quiet, claimNote };
  }

  return { create, K_MAIL, MAX_LETTERS, KEEP_DAYS, TITLE_MAX, LINE_MAX };
});
