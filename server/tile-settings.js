'use strict';
// POST /settings/tile: the choices a tile keeps in the settings blob (a Discord
// favourite, the ChatGPT model, a lyrics option, the Notifications tile switches),
// saved from a widget on the screen. A layer page never writes the whole blob
// (js/settings.js _settingsReadOnly), so without this those taps were lost.
// An allowlist of top-level fields and shapes; the server normaliser does the rest.
// `dashboardCards` is the one field that is not top-level: which cards a tile
// shows (the System tile's FPS), merged into dashboardLayout.cards.

const MAX_BYTES = 16 * 1024;
const MAX_LIST = 500;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const SHAPES = Object.freeze({
  list: (v) => Array.isArray(v) && v.length <= MAX_LIST,
  bool: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  object: isPlain,
});

const FIELDS = Object.freeze({
  discordFavChannels: 'list',
  discordCollapsedGuilds: 'list',
  chatgptWidget: 'object',
  mediaLyrics: 'bool',
  lyricsTranslate: 'bool',
  lyricsReading: 'bool',
  lyricsStage: 'bool',
  lyricsOffsetMs: 'number',
  lyricsTranslateCap: 'number',
  windowsNotifications: 'object',
  dashboardCards: 'cards',
});

// Fields merged into the stored object instead of replacing it: the tile sends
// only the switch it changed.
const MERGED = Object.freeze({ windowsNotifications: Object.freeze(['enabled', 'hide', 'toast', 'excluded']) });

// { group: { card: shown } }, every group and card one the dashboard has
// (server.js DASHBOARD_CARD_IDS). Only on/off: order and size stay the dashboard's.
function cardsShape(v, ids) {
  if (!isPlain(v) || !isPlain(ids) || !Object.keys(v).length) return false;
  return Object.entries(v).every(([group, shown]) => Array.isArray(ids[group]) && isPlain(shown)
    && Object.keys(shown).length > 0
    && Object.entries(shown).every(([card, on]) => ids[group].includes(card) && typeof on === 'boolean'));
}

// body → { patch } or { error }. `cards`: the card ids per group.
function plan(body, { cards } = {}) {
  const patch = body && body.patch;
  if (!isPlain(patch)) return { error: 'bad_patch' };
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > 4) return { error: 'bad_patch' };
  if (JSON.stringify(patch).length > MAX_BYTES) return { error: 'too_large' };
  for (const key of keys) {
    const shape = FIELDS[key];
    if (!shape) return { error: 'not_allowed', field: key };
    const valid = shape === 'cards' ? cardsShape(patch[key], cards) : SHAPES[shape](patch[key]);
    if (!valid) return { error: 'bad_value', field: key };
    const sub = MERGED[key];
    if (sub && Object.keys(patch[key]).some((k) => !sub.includes(k))) return { error: 'bad_value', field: key };
  }
  return { patch };
}

// The stored layout with these cards shown or hidden, the rest of it untouched.
function withCards(layout, change) {
  const base = isPlain(layout) ? layout : {};
  const cards = isPlain(base.cards) ? { ...base.cards } : {};
  for (const [group, shown] of Object.entries(change)) {
    const old = isPlain(cards[group]) ? cards[group] : {};
    const next = { ...old };
    for (const [card, on] of Object.entries(shown)) next[card] = { ...(isPlain(old[card]) ? old[card] : {}), visible: on };
    cards[group] = next;
  }
  return { ...base, cards };
}

// Pure: the stored settings plus the change (merged fields keep what was not sent).
function apply(settings, patch) {
  const cur = settings || {};
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'dashboardCards') out.dashboardLayout = withCards(out.dashboardLayout || cur.dashboardLayout, value);
    else out[key] = MERGED[key] ? { ...(isPlain(cur[key]) ? cur[key] : {}), ...value } : value;
  }
  return out;
}

module.exports = { FIELDS, plan, apply };
