'use strict';
// Gallery capabilities: open the gallery on the PC's screens (the Deck key on
// a screen opens it right there, js/deck.js; this is the Virtual Deck and the
// voice), and list what Xenon captured for Xenon AI ("what did I record
// yesterday?"). Ids and names only, never a path.
//
// deps.capture (injected, as for the screenshot capability):
//   store   () → the captures index
//   openGallery ({ filter, id }) → shows the gallery on the dashboards

const FILTERS = Object.freeze(['all', 'video', 'screenshot']);
const LIST_KINDS = Object.freeze(['all', 'video', 'screenshot', 'recording', 'replay', 'gif']);
const LIST_MAX = 30;

function open(d, action) {
  const c = d && d.capture;
  if (!c || typeof c.openGallery !== 'function') return { ok: false, error: 'unavailable' };
  const id = String(action.id || '');
  if (id && !(typeof c.store === 'function' && c.store() && c.store().get(id))) return { ok: false, error: 'not_found' };
  const filter = FILTERS.includes(action.filter) && action.filter !== 'all' ? action.filter : '';
  c.openGallery({ filter, ...(id ? { id } : {}) });
  return { ok: true, opened: true };
}

// The folder label the user meant: exact first, then ignoring case, then a
// part of it ("cyberpunk" → "Cyberpunk2077").
function matchGame(labels, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return '';
  return labels.find(l => l.toLowerCase() === w) || labels.find(l => l.toLowerCase().includes(w)) || null;
}

async function list(d, action) {
  const c = d && d.capture;
  const store = c && typeof c.store === 'function' && c.store();
  if (!store) return { ok: false, error: 'unavailable' };
  const games = store.games();
  const game = matchGame(games.map(g => g.label), action.game);
  if (game === null) return { ok: false, error: 'no_such_game', games: games.map(g => g.label) };
  const kind = LIST_KINDS.includes(action.kind) && action.kind !== 'all' ? action.kind : '';
  const limit = Math.max(1, Math.min(LIST_MAX, Math.trunc(Number(action.limit)) || 10));
  const page = await store.browse({ kind, game, limit });
  return {
    ok: true,
    captures: page.entries.map(e => ({
      id: e.id, kind: e.kind, name: e.name, game: e.game.replace(/\.exe$/i, '') || 'Desktop',
      when: new Date(e.createdAt).toISOString(),
      ...(e.seconds ? { seconds: e.seconds } : {}),
    })),
    more: page.more,
    games: games.map(g => g.label),
  };
}

module.exports = { FILTERS, LIST_KINDS, LIST_MAX, open, list, matchGame };
