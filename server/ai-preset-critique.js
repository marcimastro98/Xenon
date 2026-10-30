'use strict';

// The critique of a create_preset creation: objective design findings computed
// from what the user would actually get (the data after the import's own
// normalizers), so the model can fix them BEFORE the user sees the creation.
// Next to the report (what the import drops or changes), never instead of it.
//
// Each finding is {severity: 'fix'|'consider', where, problem, hint}. 'fix' is
// measurably wrong (text below its WCAG contrast minimum, tiles that overlap, a
// key that does nothing); 'consider' is near a threshold or likely unintended.
// Taste is never judged. Layout, deck and shared pieces live in
// ai-preset-critique-layout.js, -deck.js and -core.js.

const PresetShare = require('./js/preset-share.js');
const TopbarShare = require('./js/topbar-share.js');
const CustomBg = require('./js/custom-bg.js');
const themePalette = require('./js/theme-palette.js');
const { BODY_TEXT, LARGE_TEXT, finding, contrastFinding } = require('./ai-preset-critique-core.js');
const { critiquePage, critiqueScene } = require('./ai-preset-critique-layout.js');
const { critiqueDeck } = require('./ai-preset-critique-deck.js');
const { critiqueStoreRules } = require('./ai-preset-critique-store.js');
const { critiqueTileFit } = require('./ai-preset-critique-fit.js');
const { critiqueBgFrame, critiquePackageFrames } = require('./ai-preset-critique-perf.js');

const MAX_FINDINGS = 20;
// Code this close to the cap leaves no room for the next edit.
const BG_NEAR_LIMIT = 0.9;
// Surfaces under this contrast against the background are the same colour.
const SAME_SURFACE = 1.02;

// ── theme ──────────────────────────────────────────────────────────────────

// [derived role, on, minimum, theme key to change]
const THEME_PAIRS = [
  ['text', 'background', BODY_TEXT, 'text'], ['text', 'surface', BODY_TEXT, 'text'], ['text', 'surfaceAlt', BODY_TEXT, 'text'],
  ['muted', 'background', BODY_TEXT, 'mutedText'], ['muted', 'surface', BODY_TEXT, 'mutedText'], ['muted', 'surfaceAlt', BODY_TEXT, 'mutedText'],
  ['onAccent', 'accent', BODY_TEXT, 'accentText'], ['accent', 'surface', LARGE_TEXT, 'accent'],
  ['success', 'surface', LARGE_TEXT, 'successColor'], ['warning', 'surface', LARGE_TEXT, 'warningColor'],
  ['danger', 'surface', LARGE_TEXT, 'dangerColor'], ['info', 'surface', LARGE_TEXT, 'infoColor'],
];
const PALETTE_KEYS = ['accent', 'background', 'text', 'paletteVariants', ...themePalette.VARIANT_OPTIONAL_KEYS];

// The palette each shown tone paints, built the way js/settings.js
// deriveEffectiveThemePalette does (stock auto palette, the variant for the
// tone, Comic's paper surface).
function themeTones(norm) {
  const tones = norm.appearance === 'auto' ? ['light', 'dark'] : [norm.appearance === 'light' ? 'light' : 'dark'];
  return tones.map((tone) => {
    const source = Object.assign({}, norm);
    if (norm.appearance === 'auto' && norm.autoPalette === true) {
      Object.assign(source, themePalette.STOCK[tone], { accent: norm.accent });
      for (const key of themePalette.VARIANT_OPTIONAL_KEYS) source[key] = null;
    }
    Object.assign(source, themePalette.applyVariant(source, themePalette.variantFor(norm.paletteVariants, tone)));
    if (norm.styleMode === 'comic' && !source.surface) source.surface = source.background;
    return { tone, palette: themePalette.derive(source, tone) };
  });
}

function critiqueTheme(data, deps) {
  const out = [];
  if (data.bgCustom && data.bgCustom.code) out.push(...critiqueBgCode(data.bgCustom.code, 'bgCustom.code'));
  // A theme with no colours keeps the user's own palette; Retro paints a fixed one.
  if (!PALETTE_KEYS.some((k) => k in data)) return out;
  const norm = deps.normalizeSettings(PresetShare.themeImportPatch(data));
  if (norm.styleMode === 'retro') return out;
  const guardOff = norm.contrastGuard === false ? '; contrastGuard is off, so the app will not repair it' : '';
  for (const { tone, palette } of themeTones(norm)) {
    for (const [role, on, min, key] of THEME_PAIRS) {
      const f = contrastFinding(tone + ': ' + role + ' on ' + on, palette[role], [palette[on]], min, key);
      if (f) out.push(Object.assign(f, f.severity === 'fix' && guardOff ? { hint: f.hint + guardOff } : {}));
    }
    if (norm.styleMode !== 'comic' && themePalette.contrast(palette.surface, palette.background) < SAME_SURFACE) {
      out.push(finding('consider', tone + ': surface on background', 'tiles (' + palette.surface + ') are the same colour as the background (' + palette.background + ')',
        'set surface a few steps lighter or darker than background'));
    }
  }
  return out;
}

// ── animated background, top bar ──────────────────────────────────────────

function critiqueBgCode(code, where) {
  const out = critiqueBgFrame(code, where);
  const size = String(code || '').length;
  if (size >= CustomBg.CODE_MAX * BG_NEAR_LIMIT) out.push(finding('consider', where, size + ' of ' + CustomBg.CODE_MAX + ' characters: the next edit may not fit', 'shorten the code (shared helpers, fewer literals)'));
  return out;
}

function critiqueTopbar(data, deps) {
  const share = TopbarShare.read(data);
  if (!share || !data.clock || !Array.isArray(data.clock.items)) return [];
  const items = deps.normalizeSettings(TopbarShare.patch({}, share)).topbarClock.items;
  return items.length && items.every((i) => i.hidden)
    ? [finding('consider', 'clock.items', 'every island item is hidden: the island shows nothing', 'show at least the time')]
    : [];
}

// ── widget and Ambient packages ────────────────────────────────────────────

const TEXT_FILE = /\.(html?|m?js|css|svg|txt)$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function textFiles(entry) {
  return (entry.payload && Array.isArray(entry.payload.files) ? entry.payload.files : [])
    .filter((f) => TEXT_FILE.test(f.path))
    .map((f) => ({ path: f.path, text: Buffer.from(String(f.data || ''), 'base64').toString('utf8') }));
}

// A stream is "used" when the code names it as a string or a property; a host
// when its name appears at all. Lenient on purpose: a miss is a real grant the
// user is asked for with nothing in the code that needs it.
function critiquePackage(entry) {
  const files = textFiles(entry);
  const text = files.map((f) => f.text).join('\n');
  const out = critiquePackageFrames(files);
  for (const stream of entry.streams || []) {
    const used = new RegExp('[\'"`]' + escapeRe(stream) + '[\'"`]|[.\\s{,]' + escapeRe(stream) + '\\s*[:(]').test(text);
    if (!used) out.push(finding('fix', 'manifest.streams', 'asks for the "' + stream + '" stream but no file uses it', 'remove it, so the user is not asked for data the widget never reads'));
  }
  for (const host of entry.hosts || []) {
    if (!text.includes(String(host).replace(/^\*\./, ''))) {
      out.push(finding('fix', 'manifest.hosts', 'asks to reach ' + host + ' but no file fetches it', 'remove it, or fetch it'));
    }
  }
  if (!/color-scheme|colorScheme/.test(text)) {
    out.push(finding(entry.surface === 'ambient' ? 'consider' : 'fix', 'index.html', 'no color-scheme declared: the frame paints an opaque white block behind a transparent page (WIDGET_SDK.md, the white-tile trap)',
      'add :root { color-scheme: dark; } and follow theme.appearance'));
  }
  // A tile is resized and reshaped; a full-screen Ambient scene is not.
  if (entry.surface !== 'ambient') out.push(...critiqueTileFit(text));
  out.push(...critiqueStoreRules(entry, text));
  return out;
}

const prefixed = (prefix, list) => list.map((f) => Object.assign({}, f, { where: prefix + ': ' + f.where }));
const packagesOf = (list, key) => (Array.isArray(list) ? list.flatMap((w, i) => prefixed(key + '[' + i + '] ' + w.id, critiquePackage(w))) : []);

// ── per kind ───────────────────────────────────────────────────────────────

function critiqueBundle(data, deps) {
  return [
    ...(data.theme ? prefixed('theme', critiqueTheme(data.theme, deps)) : []),
    ...(data.bg ? prefixed('bg', critiqueBgCode(data.bg.code, 'code')) : []),
    ...(data.topbar ? prefixed('topbar', critiqueTopbar(data.topbar, deps)) : []),
    ...(data.pages || []).flatMap((p, i) => prefixed('pages[' + i + ']', critiquePage(p.data, deps))),
    ...(data.decks || []).flatMap((d, i) => prefixed('decks[' + i + ']', critiqueDeck(d))),
    ...packagesOf(data.widgets, 'widgets'),
  ];
}

const KINDS = {
  theme: critiqueTheme,
  bg: (data) => critiqueBgCode(data.code, 'code'),
  page: critiquePage,
  topbar: critiqueTopbar,
  deck: (data) => [...critiqueDeck(data), ...packagesOf(data.widgets, 'widgets')],
  'ambient-layout': (data) => [...critiqueScene(data.scene), ...packagesOf(data.widgets, 'widgets')],
  widget: critiquePackage,
  ambient: critiquePackage,
  icons: () => [],
  bundle: critiqueBundle,
};

// `data` is what the code carries (the checks' output). → {fix, consider,
// findings?, more?}: counts first, fixes before considerations, capped.
function critiquePreset(kind, data, deps) {
  const run = KINDS[kind];
  const all = run ? run(data, deps) : [];
  const fixes = all.filter((f) => f.severity === 'fix');
  const ordered = [...fixes, ...all.filter((f) => f.severity !== 'fix')];
  const out = { fix: fixes.length, consider: all.length - fixes.length };
  if (ordered.length) out.findings = ordered.slice(0, MAX_FINDINGS);
  if (ordered.length > MAX_FINDINGS) out.more = ordered.length - MAX_FINDINGS;
  return out;
}

// Extra "consider" findings from elsewhere (the hub's design check on Xenon
// credits) added to a critique, after its own and within the same cap.
function addConsiderations(critique, extra) {
  if (!critique || !Array.isArray(extra) || !extra.length) return critique;
  const all = [...(critique.findings || []), ...extra];
  const out = { ...critique, consider: critique.consider + extra.length, findings: all.slice(0, MAX_FINDINGS) };
  const more = (critique.more || 0) + Math.max(0, all.length - MAX_FINDINGS);
  if (more) out.more = more; else delete out.more;
  return out;
}

module.exports = { critiquePreset, addConsiderations, critiqueTheme, critiqueTopbar, critiquePackage, critiqueBgCode, MAX_FINDINGS, SAME_SURFACE };
