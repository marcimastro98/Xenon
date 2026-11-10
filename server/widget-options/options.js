// A Store widget's own choices, shown by Xenon in the menu's panel of that widget
// (manifest `options`, docs/WIDGET_SDK.md §4e-ter): switches and one-of-a-few lists,
// set there and handed to the widget in `init.options`. Read from a manifest and
// from a stored file, so everything is checked here and nothing is trusted. Shared
// by the package scan, the store and the menu (one normalizer, one stored shape).
'use strict';

const KINDS = Object.freeze(['toggle', 'select', 'group']);
const MAX_OPTIONS = 32;
const MAX_CHOICES = 8;
const LABEL_MAX = 60;
const ID_RE = /^[a-z][a-zA-Z0-9_-]{0,31}$/;
const LANG_RE = /^[a-z]{2}$/;
const MAX_PACKAGES = 96;

const cleanText = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LABEL_MAX) : '');

// A label is one text, or a text per language ({ en, it, … }). English, or the first
// given, answers for a language it does not have.
function cleanLabel(raw) {
  const one = cleanText(raw);
  if (one) return one;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [lang, text] of Object.entries(raw)) {
    const t = cleanText(text);
    if (LANG_RE.test(lang) && t) out[lang] = t;
  }
  return Object.keys(out).length ? Object.freeze(out) : null;
}

function labelText(label, lang) {
  if (typeof label === 'string') return label;
  if (!label || typeof label !== 'object') return '';
  return label[lang] || label.en || Object.values(label)[0] || '';
}

function cleanChoices(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const c of raw.slice(0, MAX_CHOICES)) {
    const value = c && typeof c.value === 'string' && ID_RE.test(c.value) ? c.value : '';
    const label = c ? cleanLabel(c.label) : null;
    if (value && label && !out.some((o) => o.value === value)) out.push(Object.freeze({ value, label }));
  }
  return out.length >= 2 ? Object.freeze(out) : null;
}

function cleanOption(raw, groups) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  const label = cleanLabel(raw.label);
  if (!id || !label) return null;
  if (raw.kind === 'group') return { id, kind: 'group', label };
  if (raw.kind === 'toggle') {
    const out = { id, kind: 'toggle', label, default: raw.default === true };
    if (typeof raw.group === 'string' && groups.has(raw.group)) out.group = raw.group;
    return out;
  }
  const choices = cleanChoices(raw.choices);
  if (!choices) return null;
  const known = choices.some((c) => c.value === raw.default);
  return { id, kind: 'select', label, choices, default: known ? raw.default : choices[0].value };
}

// The manifest's `options`, in order; an entry that is not right is left out, never guessed.
function normalizeDeclared(raw) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out = [];
  const groups = new Set();
  for (const entry of raw.slice(0, MAX_OPTIONS)) {
    const opt = cleanOption(entry, groups);
    if (!opt || out.some((o) => o.id === opt.id)) continue;
    if (opt.kind === 'group') groups.add(opt.id);
    out.push(Object.freeze(opt));
  }
  return Object.freeze(out);
}

const settable = (declared) => declared.filter((o) => o.kind !== 'group');

function validValue(opt, v) {
  if (opt.kind === 'toggle') return typeof v === 'boolean';
  return opt.choices.some((c) => c.value === v);
}

// What the widget is told: every declared choice, the stored one when it is still valid.
function resolve(declared, stored) {
  const saved = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const opt of settable(declared || [])) {
    out[opt.id] = Object.prototype.hasOwnProperty.call(saved, opt.id) && validValue(opt, saved[opt.id]) ? saved[opt.id] : opt.default;
  }
  return out;
}

// One change from the menu: 'on'/'off' for a switch, the value for a list. Null when
// the option or the value is not one the widget declared.
function applyChange(declared, stored, id, value) {
  const opt = settable(declared || []).find((o) => o.id === id);
  if (!opt) return null;
  const v = opt.kind === 'toggle' ? (value === 'on' ? true : value === 'off' ? false : null) : value;
  if (!validValue(opt, v)) return null;
  return { ...resolve(declared, stored), [id]: v };
}

// The options as Bit reads and sets them (list_widget_options, list_layer_widgets): id,
// kind, the value now and the choices of a list. English words: the AI says them its own way.
function describe(declared, values) {
  const now = values && typeof values === 'object' ? values : {};
  return settable(declared || []).map((o) => ({
    id: o.id, kind: o.kind, label: labelText(o.label, 'en'), value: now[o.id],
    ...(o.kind === 'select' ? { choices: o.choices.map((c) => c.value) } : {}),
  }));
}

// The stored file: { [packageId]: { [optionId]: true|false|'value' } }. Shape only:
// whether a value is still one the widget offers is resolve()'s question.
function normalizeStored(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [pkg, values] of Object.entries(raw).slice(0, MAX_PACKAGES)) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkg) || !values || typeof values !== 'object' || Array.isArray(values)) continue;
    const clean = {};
    for (const [id, v] of Object.entries(values).slice(0, MAX_OPTIONS)) {
      if (ID_RE.test(id) && (typeof v === 'boolean' || (typeof v === 'string' && ID_RE.test(v)))) clean[id] = v;
    }
    out[pkg] = clean;
  }
  return out;
}

module.exports = { KINDS, MAX_OPTIONS, MAX_CHOICES, normalizeDeclared, labelText, resolve, applyChange, normalizeStored, describe };
