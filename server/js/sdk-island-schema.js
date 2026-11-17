'use strict';
// Structured Dynamic Island payload normalizer. Shared by the browser host and
// unit tests: a widget can describe a Live Activity, but Xenon rebuilds every
// block from this small allowlist and renders it itself. No widget HTML, CSS or
// event handler ever crosses the sandbox boundary.
// The island, the mini slot and a badge's parts speak this one vocabulary. Style
// keys (colour, size, a bar's shape) appear only when the widget sent a valid
// one, so an old payload normalizes exactly as it always did.
(function initSdkIslandSchema(root) {
  const MAX_BLOCKS = 10;
  const MAX_ACTIONS = 2;
  const MAX_BARS = 12;
  // Tappable meters per view. Separate from buttons: four indicators that each
  // open their own detail are one readout, not four calls to action.
  const MAX_INDICATORS = 4;
  const DETAIL_ROWS = 6;
  const BLOCK_TYPES = Object.freeze(['text', 'icon', 'progress', 'bars', 'builtin', 'button', 'spacer', 'meter']);
  const BUILTINS = Object.freeze(['time', 'date', 'weather']);
  const LAYOUTS = Object.freeze(['compact', 'expanded', 'full']);
  const ENTERS = Object.freeze(['morph', 'slide', 'pop', 'fade']);
  const EXITS = Object.freeze(['morph', 'slide', 'fade']);
  const TONES = Object.freeze(['primary', 'muted', 'accent', 'success', 'warning', 'danger']);
  const SIZES = Object.freeze(['small', 'medium', 'large']);
  const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  // A host icon is named, never drawn by the widget: the id is looked up in the
  // app's own library at render time (an unknown id falls back to the glyph).
  const ICON_NAME_RE = /^[a-z][a-zA-Z0-9]{0,23}$/;
  // A widget's own icon is ONE path's `d` on a 24x24 box: path commands and
  // numbers only, so it can describe a shape and nothing else (no element, no
  // attribute, no url). The host builds the <svg> around it.
  const PATH_RE = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
  const PATH_MAX = 1200;

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

  function hexOf(value) {
    return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : '';
  }

  // A whole number of pixels inside [lo, hi], or 0 when absent or not a number.
  function pixels(value, lo, hi) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : 0;
  }

  // { text?, name?, path? }: a glyph, a host icon id and/or a widget path. The
  // renderer prefers path, then name, then the glyph, so a widget can send a
  // glyph as the fallback for an older Xenon.
  function normalizeIcon(raw, glyph) {
    const out = {};
    const text = cleanText(glyph, 8);
    if (text) out.text = text;
    if (raw && typeof raw.name === 'string' && ICON_NAME_RE.test(raw.name)) out.name = raw.name;
    if (raw && typeof raw.path === 'string') {
      const path = raw.path.trim().replace(/\s+/g, ' ');
      if (path.length <= PATH_MAX && PATH_RE.test(path)) out.path = path;
    }
    return out;
  }

  function hasIcon(src) { return !!(src.text || src.name || src.path); }

  function addStyle(out, raw) {
    const color = hexOf(raw.color);
    if (color) out.color = color;
    if (SIZES.includes(raw.size)) out.size = raw.size;
    return out;
  }

  function addBarShape(out, raw) {
    if (raw.orientation === 'vertical') out.orientation = 'vertical';
    if (pixels(raw.width, 2, 160)) out.width = pixels(raw.width, 2, 160);
    if (pixels(raw.height, 2, 40)) out.height = pixels(raw.height, 2, 40);
    return out;
  }

  function normalizeDetailRow(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const label = cleanText(raw.label, 32);
    const value = cleanText(raw.value, 24);
    if (!label && !value) return null;
    const row = Object.assign({ label, value }, normalizeIcon(raw, raw.icon));
    const color = hexOf(raw.color);
    if (color) row.color = color;
    if (raw.progress != null && Number.isFinite(Number(raw.progress))) row.progress = number01(raw.progress, 0);
    return row;
  }

  // The card a tap on a meter opens. Text only, drawn by the host like every
  // block: a title, up to six label/value rows and a short note.
  function normalizeDetail(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = cleanText(raw.title, 40);
    const note = cleanText(raw.note, 160);
    const rows = (Array.isArray(raw.rows) ? raw.rows : [])
      .slice(0, DETAIL_ROWS * 4).map(normalizeDetailRow).filter(Boolean).slice(0, DETAIL_ROWS);
    if (!title && !note && !rows.length) return null;
    return { title, note, rows };
  }

  function takeId(raw, ctx) {
    const id = cleanText(raw.id, 32).toLowerCase();
    return ACTION_ID_RE.test(id) && !ctx.ids.has(id) ? id : '';
  }

  // An indicator in the Vitals shape: a glyph over a small bar, an optional
  // short label, its own tap (`id`) and its own detail card.
  function normalizeMeter(raw, ctx) {
    const src = normalizeIcon(raw, raw.icon);
    const label = cleanText(raw.label, 8);
    if (!hasIcon(src) && !label) return null;
    const out = addStyle(Object.assign({ type: 'meter', value: number01(raw.value, 0) }, src, label ? { label } : {}), raw);
    const detail = normalizeDetail(raw.detail);
    if (detail) out.detail = detail;
    const id = raw.id == null ? '' : takeId(raw, ctx);
    if (id && ctx.meters < MAX_INDICATORS) {
      ctx.ids.add(id);
      ctx.meters += 1;
      out.id = id;
    }
    return out;
  }

  function normalizeBlock(raw, ctx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !BLOCK_TYPES.includes(raw.type)) return null;
    if (raw.type === 'text') {
      const text = cleanText(raw.text, 160);
      if (!text) return null;
      return addStyle({
        type: 'text', text,
        tone: TONES.includes(raw.tone) ? raw.tone : 'primary',
        weight: raw.weight === 'strong' ? 'strong' : 'normal',
        maxLines: raw.maxLines === 2 ? 2 : 1,
      }, raw);
    }
    if (raw.type === 'icon') {
      const src = normalizeIcon(raw, raw.text);
      if (!hasIcon(src)) return null;
      const out = { type: 'icon', text: src.text || '', color: hexOf(raw.color) };
      if (src.name) out.name = src.name;
      if (src.path) out.path = src.path;
      if (SIZES.includes(raw.size)) out.size = raw.size;
      return out;
    }
    if (raw.type === 'progress') {
      const out = { type: 'progress', value: number01(raw.value, 0) };
      if (hexOf(raw.color)) out.color = hexOf(raw.color);
      return addBarShape(out, raw);
    }
    if (raw.type === 'meter') return normalizeMeter(raw, ctx);
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
      const id = takeId(raw, ctx);
      const label = cleanText(raw.label, 28);
      if (!id || !label || ctx.buttons >= MAX_ACTIONS) return null;
      ctx.ids.add(id);
      ctx.buttons += 1;
      return { type: 'button', id, label, emphasis: raw.emphasis === true };
    }
    const size = raw.size === 'large' ? 'large' : 'small';
    return { type: 'spacer', size };
  }

  function newCtx() { return { ids: new Set(), buttons: 0, meters: 0 }; }

  function accentOf(raw) {
    return typeof raw.accent === 'string' && HEX_RE.test(raw.accent.trim()) ? raw.accent.trim().toLowerCase() : '';
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.op === 'clear') {
      const scope = ['live', 'takeover', 'all'].includes(raw.scope) ? raw.scope : 'all';
      return { op: 'clear', scope };
    }
    if (raw.op !== 'present' && raw.op !== 'show') return null;
    const mode = raw.mode === 'takeover' ? 'takeover' : 'live';
    const ctx = newCtx();
    const source = Array.isArray(raw.blocks) ? raw.blocks : [];
    const blocks = [];
    for (const candidate of source) {
      const block = normalizeBlock(candidate, ctx);
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
      accent: accentOf(raw),
      blocks,
    };
  }

  // A slot in the bar is as tall as the bar's buttons: a bar drawn taller or
  // wider than that would push the buttons, so its shape is capped here.
  function fitToBar(block, maxHeight) {
    if (block.type !== 'progress') return block;
    if (block.height > maxHeight) block.height = maxHeight;
    if (block.width > 120) block.width = 120;
    return block;
  }

  function collect(source, types, cap, ctx, buttonCap) {
    const blocks = [];
    for (const candidate of Array.isArray(source) ? source : []) {
      if (!candidate || typeof candidate !== 'object' || !types.includes(candidate.type)) continue;
      // normalizeBlock enforces the ISLAND's button budget (MAX_ACTIONS), which
      // is larger, so a smaller surface's cap has to be applied here.
      if (candidate.type === 'button' && ctx.buttons >= buttonCap) continue;
      const block = normalizeBlock(candidate, ctx);
      if (block) blocks.push(block);
      if (blocks.length >= cap) break;
    }
    return blocks;
  }

  // The mini slot (topbar button row) speaks the SAME block vocabulary as the
  // island, so a widget author learns one thing and the two surfaces cannot
  // drift apart. What differs is the room and the nature of the surface:
  //  - it sits between real buttons, so 4 blocks and 1 button, not 10 and 2;
  //  - there is no `builtin`: mirroring the clock into a slot that may sit right
  //    beside the actual clock is a duplicate, not a feature;
  //  - there is no takeover lane and no duration. A slot in the bar is a STATE
  //    the user chose to keep on screen, not an announcement that expires;
  //  - there is no layout: the slot's size is the bar's business, not the
  //    package's.
  const MINI_MAX_BLOCKS = 4;
  const MINI_MAX_ACTIONS = 1;
  const MINI_BLOCK_TYPES = Object.freeze(['text', 'icon', 'progress', 'bars', 'button', 'meter']);

  function normalizeMini(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.op === 'clear') return { op: 'clear' };
    if (raw.op !== 'present' && raw.op !== 'show' && raw.op !== 'set') return null;
    const blocks = collect(raw.blocks, MINI_BLOCK_TYPES, MINI_MAX_BLOCKS, newCtx(), MINI_MAX_ACTIONS)
      .map((block) => fitToBar(block, 24));
    if (!blocks.length) return null;
    return { op: 'present', accent: accentOf(raw), tooltip: cleanText(raw.tooltip, 60), blocks };
  }

  // A badge's parts: several independently styled pieces inside one chip next
  // to the clock. No buttons (the chip itself is the tap) and short text only.
  const BADGE_MAX_BLOCKS = 4;
  const BADGE_BLOCK_TYPES = Object.freeze(['text', 'icon', 'progress', 'meter']);
  const BADGE_PART_TEXT_MAX = 32;

  function normalizeBadgeBlocks(source) {
    return collect(source, BADGE_BLOCK_TYPES, BADGE_MAX_BLOCKS, newCtx(), 0)
      .map((block) => {
        if (block.type === 'text' && block.text.length > BADGE_PART_TEXT_MAX) {
          block.text = block.text.slice(0, BADGE_PART_TEXT_MAX).trim();
        }
        return fitToBar(block, 16);
      });
  }

  const api = {
    MAX_BLOCKS, MAX_ACTIONS, MAX_BARS, MAX_INDICATORS, DETAIL_ROWS, BLOCK_TYPES, BUILTINS, LAYOUTS, SIZES,
    normalize, normalizeIcon, normalizeDetail,
    MINI_MAX_BLOCKS, MINI_MAX_ACTIONS, MINI_BLOCK_TYPES, normalizeMini,
    BADGE_MAX_BLOCKS, BADGE_BLOCK_TYPES, normalizeBadgeBlocks,
  };
  if (root && typeof root === 'object') root.SdkIslandSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
