'use strict';

// What Bit has to tell the person: an announcement from the hub, the month's
// drops, the Sparks running low, the one-time asks. This is the inbox behind the
// card in the corner (js/bit-messages.js), kept here and not in a page because
// "widgets only" has no dashboard and a phone has its own storage: a message read
// on one screen must be gone from all of them, and the one-a-day limit has to be
// one limit.
//
// A message waits here until it is its turn. `next` is the one message a screen
// may show now: one already shown and not read yet keeps showing, otherwise the
// day's one new message, if the day still has one. Whatever has been shown stays
// for the chat with Bit, for 90 days.
//
// Everything arrives from a page, so it is rebuilt field by field here: pictures
// only from the hosts the hub feed may use, links only to its hosts, and an action
// is one of a short list. Nothing here decides who sees what. Targeting stays on
// the machine (js/hub-messages.js, community-messages.js).

const fs = require('fs');
const { writeFileAtomic } = require('./atomic-write');
const { normalizeAction, normalizeMedia, normalizePoll } = require('./community-messages');

const ID_RE = /^[a-z0-9][a-z0-9:_.-]{0,95}$/i;
const ENTRY_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const KINDS = new Set(['hub', 'drop', 'sparks', 'support', 'share', 'rate']);
// Highest first, when several wait for the same day. A vote never takes the day
// from anything else.
const PRIORITY = { hub: 5, drop: 4, sparks: 3, support: 2, share: 1, rate: 0 };
// Actions a message made by the app itself may carry, besides the feed's own.
const APP_ACTIONS = new Set(['sparks', 'share']);
const SURFACES = new Set(['any', 'dashboard']);

const DAY = 24 * 3600 * 1000;
const MAX_MESSAGES = 40;
const KEEP_DAYS = 90;
const GONE_CAP = 200;
const MAX_PER_POST = 60;
const TITLE_MAX = 120;
const LINE_MAX = 240;
const BODY_MAX = 600;
const LABEL_MAX = 40;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

const cleanTime = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function cleanAction(raw, entryId) {
  if (!raw || typeof raw !== 'object') return null;
  if (APP_ACTIONS.has(raw.type)) {
    const label = cleanText(raw.label, LABEL_MAX);
    return label ? { type: raw.type, label } : null;
  }
  const action = normalizeAction(raw, entryId);
  return action && action.type !== 'dismiss' ? action : null;
}

// One message in the shape every screen trusts, or null.
function cleanMessage(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  const title = cleanText(raw.title, TITLE_MAX);
  if (!id || !title || !KINDS.has(raw.kind)) return null;

  const msg = {
    id,
    kind: raw.kind,
    at: Math.min(cleanTime(raw.at) || now, now),
    title,
    line: cleanText(raw.line, LINE_MAX),
    body: cleanText(raw.body, BODY_MAX),
    where: raw.where === 'stage' ? 'stage' : 'corner',
    surface: SURFACES.has(raw.surface) ? raw.surface : 'any',
    shownAt: 0,
    readAt: 0,
  };
  const entryId = typeof raw.entryId === 'string' && ENTRY_RE.test(raw.entryId) ? raw.entryId : '';
  if (entryId) msg.entryId = entryId;
  const expires = cleanTime(raw.expires);
  if (expires) msg.expires = expires;
  const since = raw.kind === 'rate' ? cleanTime(raw.since) : 0;
  if (since) msg.since = since;
  const media = normalizeMedia(raw.media);
  if (media) msg.media = media;
  const action = cleanAction(raw.action, entryId);
  if (action) msg.action = action;
  const poll = raw.poll ? normalizePoll(raw.poll) : null;
  if (poll) {
    msg.poll = poll;
    // A question is answered in the corner, on any screen: the stage has no answers.
    msg.where = 'corner';
  }
  return msg;
}

// What was on disk, trusted no more than what arrives from a page.
function restoreMessage(raw, now) {
  const msg = cleanMessage(raw, now);
  if (!msg) return null;
  msg.shownAt = cleanTime(raw.shownAt);
  msg.readAt = cleanTime(raw.readAt);
  if (msg.poll && msg.poll.options.some((o) => o.id === raw.answer)) msg.answer = raw.answer;
  return msg;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function dayOf(t) {
  const d = new Date(t);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function createBitMessages({ file, settings = () => ({}), onChange = () => {}, now = Date.now, log = console }) {
  let state = null;
  let loading = null;

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = (async () => {
        let raw = null;
        try {
          raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') log.warn('[bit-messages] unreadable store, starting empty:', e.message);
        }
        const t = now();
        const list = raw && Array.isArray(raw.messages) ? raw.messages : [];
        state = {
          messages: list.map((m) => restoreMessage(m, t)).filter(Boolean),
          gone: raw && Array.isArray(raw.gone) ? raw.gone.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(-GONE_CAP) : [],
          lastShownAt: raw ? cleanTime(raw.lastShownAt) : 0,
        };
        return state;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  async function save() {
    await writeFileAtomic(file, JSON.stringify({ v: 1, ...state }));
    onChange();
  }

  function prune() {
    const oldest = now() - KEEP_DAYS * DAY;
    const sorted = state.messages.slice().sort((a, b) => b.at - a.at);
    const keep = [];
    for (const msg of sorted) {
      if (msg.at >= oldest && keep.length < MAX_MESSAGES) keep.push(msg);
      else if (!state.gone.includes(msg.id)) state.gone.push(msg.id);
    }
    state.messages = keep;
    state.gone = state.gone.slice(-GONE_CAP);
  }

  function muted(msg) {
    const s = settings() || {};
    if (msg.kind === 'hub') return s.hubMessages === false;
    if (msg.kind === 'drop') return s.monthlyDrops === false;
    if (msg.kind === 'rate') return s.ratingAsks === false;
    return false;
  }

  function waiting(msg, surface, t) {
    if (msg.readAt || muted(msg)) return false;
    if (msg.expires && msg.expires <= t) return false;
    return surface !== 'screen' || msg.surface === 'any';
  }

  // A new install's first day is for its own setup. News and drops wait for the
  // next day; a low Sparks note follows what the person did, so it does not.
  function heldForTomorrow(msg, t) {
    if (msg.kind !== 'hub' && msg.kind !== 'drop') return false;
    const s = settings() || {};
    return s.firstRunDay === dayOf(t);
  }

  // The one message a screen may show now.
  function pick(surface) {
    const t = now();
    const open = state.messages.filter((m) => waiting(m, surface, t));
    const shown = open.filter((m) => m.shownAt).sort((a, b) => a.shownAt - b.shownAt)[0];
    if (shown) return shown;
    if (state.lastShownAt && sameDay(state.lastShownAt, t)) return null;
    const fresh = open.filter((m) => !heldForTomorrow(m, t));
    return fresh.sort((a, b) => (PRIORITY[b.kind] - PRIORITY[a.kind]) || (a.at - b.at))[0] || null;
  }

  async function view(surface) {
    await load();
    // A vote asked for is not something Bit told: it stays out of the chat.
    const told = state.messages.filter((m) => m.kind !== 'rate' && (m.shownAt || m.readAt)).sort((a, b) => b.at - a.at);
    return { messages: told, next: pick(surface === 'screen' ? 'screen' : 'dashboard') };
  }

  // A drop and an announcement about the same creation are one message, and the
  // words someone wrote for it win over the ones made from the catalog.
  function place(msg) {
    if (state.gone.includes(msg.id) || state.messages.some((m) => m.id === msg.id)) return false;
    if (!msg.entryId || msg.kind === 'rate') { state.messages.push(msg); return true; }
    if (state.gone.includes(`drop:${msg.entryId}`)) return false;
    const twin = state.messages.find((m) => m.entryId === msg.entryId && m.kind !== 'rate');
    if (!twin) { state.messages.push(msg); return true; }
    if (twin.kind !== 'drop' || msg.kind !== 'hub' || twin.shownAt || twin.readAt) return false;
    state.messages[state.messages.indexOf(twin)] = msg;
    return true;
  }

  // What the feed or the catalog no longer offers is taken back, unless it was read.
  function withdraw(live) {
    let changed = false;
    for (const kind of ['hub', 'drop']) {
      const ids = live && live[kind];
      if (!Array.isArray(ids)) continue;
      const still = new Set(ids.slice(0, GONE_CAP));
      const before = state.messages.length;
      state.messages = state.messages.filter((m) => m.kind !== kind || m.readAt || still.has(m.id));
      changed = changed || state.messages.length !== before;
    }
    return changed;
  }

  async function post({ messages, live } = {}) {
    await load();
    const t = now();
    let changed = withdraw(live);
    for (const raw of (Array.isArray(messages) ? messages : []).slice(0, MAX_PER_POST)) {
      const msg = cleanMessage(raw, t);
      if (msg && place(msg)) changed = true;
    }
    if (changed) { prune(); await save(); }
    return changed;
  }

  // The letters of the old mail, read or not: they stay readable in the chat and
  // nothing asks for attention again. `seen` are ids announced before the mail
  // kept them, which must not come back as new.
  async function importLetters({ letters, gone, seen } = {}) {
    await load();
    const t = now();
    let changed = false;
    for (const raw of (Array.isArray(letters) ? letters : []).slice(0, MAX_PER_POST)) {
      const msg = cleanMessage(raw, t);
      if (!msg || state.messages.some((m) => m.id === msg.id)) continue;
      msg.shownAt = msg.at;
      msg.readAt = msg.at;
      state.messages.push(msg);
      changed = true;
    }
    const ids = (Array.isArray(gone) ? gone : []).concat((Array.isArray(seen) ? seen : []).flatMap((id) => [`hub:${id}`, `drop:${id}`]));
    for (const id of ids.slice(-GONE_CAP)) {
      if (typeof id === 'string' && ID_RE.test(id) && !state.gone.includes(id)) { state.gone.push(id); changed = true; }
    }
    if (changed) { prune(); await save(); }
    return changed;
  }

  // A screen is showing it: that spends the day.
  async function shown(id) {
    await load();
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return false;
    if (msg.shownAt) return true;
    msg.shownAt = now();
    state.lastShownAt = msg.shownAt;
    await save();
    return true;
  }

  async function read(id, answer) {
    await load();
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return false;
    if (msg.readAt) return true;
    msg.readAt = now();
    if (!msg.shownAt) msg.shownAt = msg.readAt;
    if (msg.poll && msg.poll.options.some((o) => o.id === answer)) msg.answer = answer;
    await save();
    return true;
  }

  return { view, post, importLetters, shown, read };
}

module.exports = { createBitMessages, cleanMessage, ID_RE, MAX_MESSAGES, KEEP_DAYS, GONE_CAP };
