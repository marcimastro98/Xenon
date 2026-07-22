'use strict';
// Structured Dynamic Island payload normalizer. Shared by the browser host and
// unit tests: a widget can describe a Live Activity, but Xenon rebuilds every
// block from this small allowlist and renders it itself. No widget HTML, CSS or
// event handler ever crosses the sandbox boundary.
(function initSdkIslandSchema(root) {
  const MAX_BLOCKS = 10;
  const MAX_ACTIONS = 2;
  const MAX_BARS = 12;
  const BLOCK_TYPES = Object.freeze(['text', 'icon', 'progress', 'bars', 'builtin', 'button', 'spacer']);
  const BUILTINS = Object.freeze(['time', 'date', 'weather']);
  const LAYOUTS = Object.freeze(['compact', 'expanded', 'full']);
  const ENTERS = Object.freeze(['morph', 'slide', 'pop', 'fade']);
  const EXITS = Object.freeze(['morph', 'slide', 'fade']);
  const TONES = Object.freeze(['primary', 'muted', 'accent', 'success', 'warning', 'danger']);
  const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  function cleanText(value, max) {
    const source = String(value == null ? '' : value);
    let out = '';
    for (let i = 0; i < source.length && out.length < max; i++) {
      const code = source.charCodeAt(i);
      out += (code <= 31 || code === 127) ? ' ' : source[i];
    }
    return out.trim().replace(/\s+/g, ' ');
  }

  function number01(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  }

  function normalizeBlock(raw, actionIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !BLOCK_TYPES.includes(raw.type)) return null;
    if (raw.type === 'text') {
      const text = cleanText(raw.text, 160);
      if (!text) return null;
      return {
        type: 'text', text,
        tone: TONES.includes(raw.tone) ? raw.tone : 'primary',
        weight: raw.weight === 'strong' ? 'strong' : 'normal',
        maxLines: raw.maxLines === 2 ? 2 : 1,
      };
    }
    if (raw.type === 'icon') {
      const text = cleanText(raw.text, 8);
      if (!text) return null;
      const color = typeof raw.color === 'string' && HEX_RE.test(raw.color.trim()) ? raw.color.trim() : '';
      return { type: 'icon', text, color };
    }
    if (raw.type === 'progress') {
      return { type: 'progress', value: number01(raw.value, 0) };
    }
    if (raw.type === 'bars') {
      const values = Array.isArray(raw.values)
        ? raw.values.slice(0, MAX_BARS).map((v) => number01(v, 0))
        : [];
      if (!values.length) return null;
      return { type: 'bars', values, animated: raw.animated === true };
    }
    if (raw.type === 'builtin') {
      const value = BUILTINS.includes(raw.value) ? raw.value : '';
      return value ? { type: 'builtin', value } : null;
    }
    if (raw.type === 'button') {
      const id = cleanText(raw.id, 32).toLowerCase();
      const label = cleanText(raw.label, 28);
      if (!ACTION_ID_RE.test(id) || !label || actionIds.size >= MAX_ACTIONS || actionIds.has(id)) return null;
      actionIds.add(id);
      return { type: 'button', id, label, emphasis: raw.emphasis === true };
    }
    const size = raw.size === 'large' ? 'large' : 'small';
    return { type: 'spacer', size };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.op === 'clear') {
      const scope = ['live', 'takeover', 'all'].includes(raw.scope) ? raw.scope : 'all';
      return { op: 'clear', scope };
    }
    if (raw.op !== 'present' && raw.op !== 'show') return null;
    const mode = raw.mode === 'takeover' ? 'takeover' : 'live';
    const actionIds = new Set();
    const source = Array.isArray(raw.blocks) ? raw.blocks : [];
    const blocks = [];
    for (const candidate of source) {
      const block = normalizeBlock(candidate, actionIds);
      if (block) blocks.push(block);
      if (blocks.length >= MAX_BLOCKS) break;
    }
    if (!blocks.length) return null;
    const duration = mode === 'takeover'
      ? Math.max(1200, Math.min(30000, Math.round(Number(raw.duration) || 5000)))
      : 0;
    return {
      op: 'present', mode, duration,
      // 'full' spans the whole top bar. The schema only says the shape is legal;
      // whether this package may USE it is a grant question, answered in
      // custom-widget.js (which downgrades an ungranted 'full' rather than
      // dropping the message — the schema has no grant context here).
      layout: LAYOUTS.includes(raw.layout) ? raw.layout : 'compact',
      enter: ENTERS.includes(raw.enter) ? raw.enter : 'morph',
      exit: EXITS.includes(raw.exit) ? raw.exit : 'morph',
      accent: typeof raw.accent === 'string' && HEX_RE.test(raw.accent.trim()) ? raw.accent.trim().toLowerCase() : '',
      blocks,
    };
  }

  const api = { MAX_BLOCKS, MAX_ACTIONS, MAX_BARS, BLOCK_TYPES, BUILTINS, LAYOUTS, normalize };
  if (root && typeof root === 'object') root.SdkIslandSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
