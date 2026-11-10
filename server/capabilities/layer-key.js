'use strict';
// Put one of the person's Deck keys on the screen as a small button (drawn by
// js/layer-key.js, pressed through deck-press.js). Anyone who runs capabilities may
// place one, Bit and a Deck step included, so this file never stores a fingerprint:
// a button placed here does nothing until the person agrees to what it does.
//
// deps (injected): layers.js's, plus deck { configs() }.
const LayersModel = require('../js/layers-model.js');
const { actionSpec } = require('../js/deck-actions.js');
const { allKeys, findById, findByTitle, label } = require('./deck-shortcut.js');
const { pageIdFor, monitorFor } = require('./layers.js');
const { stepsOf, fingerprint } = require('../deck-press.js');

const CHOICES_MAX = 20;
// A key's picture rides in the Add list, so only a small one does.
const SHOT_MAX = 32 * 1024;

function pictureOf(key) {
  const icon = key.icon;
  const ok = icon && icon.type === 'image' && typeof icon.value === 'string'
    && icon.value.length <= SHOT_MAX && /^data:image\//i.test(icon.value);
  return ok ? icon.value : '';
}

// The keys that can be placed: with an id a placement can hold, and something to do.
function placeable(configs) {
  return allKeys(configs).filter((h) => LayersModel.INSTANCE_RE.test(String(h.key.id || '')) && stepsOf(h.key).length);
}

// The Add lists: a key with no title goes by what its first step does.
function choices(configs) {
  return placeable(configs).map((h) => {
    const spec = actionSpec(stepsOf(h.key)[0].action.type);
    const shot = pictureOf(h.key);
    return { id: h.key.id, title: label(h), labelKey: (spec && spec.labelKey) || '', ...(shot ? { shot } : {}) };
  });
}

function find(configs, text) {
  const byId = findById(configs, text);
  return byId.hits.length ? byId : findByTitle(configs, text);
}

async function place(d, action) {
  if (!d.deck || typeof d.deck.configs !== 'function') return { ok: false, error: 'unavailable' };
  const configs = await d.deck.configs();
  const { keys, hits } = find(configs, String(action.key || '').trim());
  if (!hits.length) return { ok: false, error: 'no_key', choices: keys.slice(0, CHOICES_MAX).map(label) };
  if (hits.length > 1) return { ok: false, error: 'ambiguous', choices: hits.slice(0, CHOICES_MAX).map(label) };
  const { key } = hits[0];
  if (!LayersModel.INSTANCE_RE.test(String(key.id || ''))) return { ok: false, error: 'failed' };
  const list = stepsOf(key);
  if (!list.length) return { ok: false, error: 'no_action' };
  const where = monitorFor(d, action);
  if (where.error) return { ok: false, error: where.error };
  const res = await d.layers.update((cur) => {
    const page = pageIdFor(cur, action.page);
    if (page.error) return page;
    return LayersModel.addWidget(cur, {
      kind: 'tile', widget: LayersModel.KEY, instance: key.id, surface: action.surface,
      position: action.position, size: 'button', monitor: where.monitor, page: page.id,
    });
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed', ...(res && res.choices ? { choices: res.choices } : {}) };
  // `fp` lets the Add a person tapped agree at once; only they can send it back.
  return { ok: true, id: res.widget.id, fp: fingerprint(list), key: label(hits[0]) };
}

module.exports = { place, choices };
