'use strict';
// A Deck key placed on the screen (js/layer-key.js): the button is drawn by the
// layer page, never by a widget, and pressing it plays the key as the Deck does.
//
// A key can be written by more than the person: Bit's configure_deck, an imported
// profile. So a button remembers what the key did when the person last agreed to
// it (`keyFp`, a fingerprint of its steps) and runs only that. A key that changed,
// or one never agreed to, answers key_changed and the button shows what it does
// now; a tap on that is the only thing that stores a fingerprint. No capability
// writes one, so nothing Bit or a Deck profile places can run on its own.
//
// deps (injected):
//   layers      { get(), update(edit) }  the saved layers, and one locked edit
//   readConfigs ()                       the stored Deck configs
//   runner      { pressKey(id, refuse) } deck-shortcut-runner.js
const crypto = require('crypto');
const { canonical } = require('./remote-actions.js');
const { actionSpec, triggerSteps } = require('./js/deck-actions.js');
const S = require('./js/deck-shortcuts.js');
const LayersModel = require('./js/layers-model.js');
const { MAX_STEPS } = require('./deck-shortcut-runner.js');

const DETAIL_MAX = 400;
const ICON_TYPES = new Set(['image', 'builtin', 'emoji']);
const ICON_MAX = 256 * 1024;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

const stepsOf = (key) => triggerSteps(S.shortcutTrigger(key)).slice(0, MAX_STEPS);

// Delays count: a key is what it does and when.
function fingerprint(list) {
  const flat = list.map((s) => [Number(s.delayMs) || 0, canonical(s.action)]);
  return crypto.createHash('sha256').update(JSON.stringify(flat)).digest('hex').slice(0, 32);
}

// Everything the action was told, arguments included: the person agrees to this.
function detailOf(action) {
  const spec = actionSpec(action.type);
  const choices = new Set(((spec && spec.params) || []).filter((p) => p.kind === 'select').map((p) => p.name));
  const text = Object.keys(action)
    .filter((k) => k !== 'type' && !choices.has(k) && typeof action[k] === 'string' && action[k].trim())
    .map((k) => action[k].trim())
    .join(' ');
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + '...' : text;
}

// Every step, none left out: [{ type, label, detail }], label being an i18n key.
function describeSteps(list) {
  return list.map((s) => {
    const spec = actionSpec(s.action.type);
    return { type: s.action.type, label: (spec && spec.labelKey) || '', detail: detailOf(s.action) };
  });
}

// The key's own look. The page checks it again before drawing.
function lookOf(key) {
  const out = { title: String(key.title || '').trim().slice(0, 80) };
  const icon = key.icon;
  if (icon && ICON_TYPES.has(icon.type) && typeof icon.value === 'string' && icon.value.length <= ICON_MAX) {
    out.icon = { type: icon.type, value: icon.value };
  }
  if (COLOR_RE.test(String(key.bg || ''))) out.bg = key.bg;
  return out;
}

function createDeckPress(d) {
  const placed = (id) => LayersModel.normalize(d.layers.get()).widgets
    .find((w) => w.id === id && LayersModel.isKey(w)) || null;

  // What the button shows. `fp` is what a tap on "confirm" agrees to.
  async function read(id) {
    const w = placed(id);
    if (!w) return { ok: false, error: 'gone' };
    const found = S.findKey(await d.readConfigs(), w.instance);
    const list = found ? stepsOf(found.key) : [];
    if (!list.length) return { ok: true, state: 'gone' };
    const fp = fingerprint(list);
    return { ok: true, state: w.keyFp === fp ? 'ready' : 'confirm', fp, ...lookOf(found.key), does: describeSteps(list) };
  }

  async function press(id) {
    const w = placed(id);
    if (!w) return { ok: false, error: 'gone' };
    return d.runner.pressKey(w.instance, (_key, list) => {
      if (!list.length) return { ok: false, error: 'gone' };
      return w.keyFp === fingerprint(list) ? null : { ok: false, error: 'key_changed' };
    });
  }

  // `fp` is the fingerprint the person was shown: a key that changed after that
  // is not what they agreed to.
  async function accept(id, fp) {
    const w = placed(id);
    if (!w) return { ok: false, error: 'gone' };
    const found = S.findKey(await d.readConfigs(), w.instance);
    const list = found ? stepsOf(found.key) : [];
    if (!list.length) return { ok: false, error: 'gone' };
    if (fingerprint(list) !== fp) return { ok: false, error: 'key_changed' };
    const res = await d.layers.update((cur) => LayersModel.setKeyFp(cur, id, fp));
    return res && !res.error ? { ok: true } : { ok: false, error: (res && res.error) || 'failed' };
  }

  return { read, press, accept };
}

module.exports = { createDeckPress, fingerprint, stepsOf, describeSteps, lookOf };
