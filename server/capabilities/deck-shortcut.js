'use strict';
// Deck key shortcuts by voice: "put Ctrl+Shift+F9 on my Music key", "take the
// shortcut off Mute", "which shortcuts do I have?". The combo rules live in
// js/deck-shortcuts.js; registering and running is server.js + the runner.
//
// deps (injected):
//   deck {
//     update(edit)   runs edit(configs) on a copy of the stored Deck configs,
//                    serialized with every other Deck write; the edit returns
//                    { changed: [instanceId], result }, and only changed
//                    instances are written back
//     status()       the per-key verdicts (server.js _deckShortcutStatus)
//     takenByOthers() the combos the search and page shortcuts hold
//   }
const S = require('../js/deck-shortcuts.js');

const OFF_WORDS = new Set(['', 'none', 'off', 'remove', 'clear', 'nessuna', 'no']);
const CHOICES_MAX = 20;

// Every action key with where it lives, folders included.
function allKeys(configs) {
  const out = [];
  for (const instance of Object.keys(configs || {}).sort()) {
    if (instance.indexOf('__') === 0) continue;
    S.eachConfigKey(configs[instance], (key, profile) => out.push({ key, instance, profile: String((profile && profile.name) || '') }));
  }
  return out;
}

const titleOf = (hit) => String(hit.key.title || '').trim();
const label = (hit) => titleOf(hit) + (hit.profile ? ' (' + hit.profile + ')' : '');

// The key a person named: the exact title first, then a title containing it.
function findByTitle(configs, name) {
  const want = String(name || '').trim().toLowerCase();
  const keys = allKeys(configs).filter((h) => titleOf(h));
  if (!want) return { keys, hits: [] };
  const exact = keys.filter((h) => titleOf(h).toLowerCase() === want);
  return { keys, hits: exact.length ? exact : keys.filter((h) => titleOf(h).toLowerCase().includes(want)) };
}

function findById(configs, id) {
  const keys = allKeys(configs).filter((h) => titleOf(h));
  return { keys, hits: allKeys(configs).filter((h) => h.key.id === String(id)) };
}

function readCombo(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (OFF_WORDS.has(text.toLowerCase())) return { combo: '' };
  const combo = S.normalizeShortcut(text);
  if (!combo) return { error: 'bad_shortcut' };
  const owner = S.reservedBy(combo);
  return owner ? { error: 'reserved', owner } : { combo };
}

async function setShortcut(d, action) {
  if (!d.deck || typeof d.deck.update !== 'function') return { ok: false, error: 'unavailable' };
  const read = readCombo(action.shortcut);
  if (read.error === 'bad_shortcut') {
    return { ok: false, error: 'bad_shortcut', rule: 'two of ctrl, alt, shift, win plus a letter or digit, or one of them plus F1-F12' };
  }
  if (read.error) return { ok: false, error: 'reserved', owner: read.owner };
  const combo = read.combo;
  const others = typeof d.deck.takenByOthers === 'function' ? d.deck.takenByOthers() : [];
  if (combo && others.includes(combo)) return { ok: false, error: 'in_use', by: 'page or search shortcut' };
  return d.deck.update((configs) => {
    // The Xenon menu names the key by its id (titles can repeat); voice by title.
    const { keys, hits } = action.keyId ? findById(configs, action.keyId) : findByTitle(configs, action.key);
    if (!hits.length) return { result: { ok: false, error: 'no_key', choices: keys.slice(0, CHOICES_MAX).map(label) } };
    if (hits.length > 1) return { result: { ok: false, error: 'ambiguous', choices: hits.slice(0, CHOICES_MAX).map(label) } };
    const hit = hits[0];
    if (typeof hit.key.id !== 'string' || !hit.key.id) return { result: { ok: false, error: 'failed' } };
    if (combo) {
      const other = S.collectShortcuts(configs).list.find((s) => s.combo === combo && s.keyId !== hit.key.id);
      if (other) return { result: { ok: false, error: 'in_use', by: other.title } };
      if (hit.key.shortcut === combo) return { result: { ok: true, key: label(hit), shortcut: S.formatShortcut(combo) } };
      hit.key.shortcut = combo;
    } else {
      if (!hit.key.shortcut) return { result: { ok: true, key: label(hit), shortcut: '' } };
      delete hit.key.shortcut;
    }
    return { changed: [hit.instance], result: { ok: true, key: label(hit), shortcut: combo ? S.formatShortcut(combo) : '' } };
  });
}

// Every key that has a shortcut, and whether it works right now.
function listShortcuts(d) {
  const list = d.deck && typeof d.deck.status === 'function' ? d.deck.status() : [];
  return { ok: true, shortcuts: list.map((s) => ({ key: s.title, shortcut: S.formatShortcut(s.combo), state: s.state })) };
}

module.exports = { setShortcut, listShortcuts, findByTitle, readCombo };
