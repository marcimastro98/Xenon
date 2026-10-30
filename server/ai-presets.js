'use strict';

// The assistant's create_preset tool: build ANY Xenon share code (page, deck,
// theme, animated background, widget, Ambient package or scene, top bar, icon
// pack, package) from data the model writes, dry-run it through the same
// normalizers the import uses, and hand the code to the import window. Nothing
// is applied or installed here: the user reviews and confirms in that window,
// exactly as with a code pasted by hand. Sound packs are audio files, which a
// text model cannot write, so they are refused.
//
// server.js internals arrive through `deps`:
//   normalizeSettings(settings) → normalized hub settings (normalizeHubSettings)
//   dashboardWidgets            → [{id, w, h}] built-in tile ids and default sizes
//   sdkEnabled                  → boolean, Community widgets switched on
//   appVersion                  → string stamped into the code

const PresetShare = require('./js/preset-share.js');
const { createReport, note, fail, summarize, isObject } = require('./ai-preset-diff.js');
const { checkTheme, checkBg, checkPage, checkTopbar, knownFields, join } = require('./ai-preset-checks.js');
const { checkWidgetEntry, checkIcons, checkAmbientLayout, checkWidgetList } = require('./ai-preset-packages.js');
const { checkDeck } = require('./ai-preset-deck.js');
const { presetReference } = require('./ai-preset-reference.js');
const { critiquePreset } = require('./ai-preset-critique.js');
const { resolvePictures, pictureProblem } = require('./ai-attached-pictures.js');

const SOUNDS_HINT = 'A sound pack is made of audio files, which cannot be written as text. Offer marketplace_search with kind "sounds", or tell the user to import their own clips in Settings.';
const BUNDLE_FIELDS = ['theme', 'pages', 'decks', 'bg', 'topbar', 'widgets'];

const CHECKS = {
  theme: checkTheme,
  bg: checkBg,
  page: checkPage,
  topbar: checkTopbar,
  deck: checkDeck,
  icons: checkIcons,
  'ambient-layout': checkAmbientLayout,
  widget: (data, ctx) => checkWidgetEntry(data, ctx, 'tile'),
  ambient: (data, ctx) => checkWidgetEntry(data, ctx, 'ambient'),
  bundle: checkBundle,
};

// A package: every part through its own kind's check, at the import's caps.
function checkBundle(data, ctx) {
  knownFields(data, BUNDLE_FIELDS, ctx, 'a package carries theme, pages, decks, bg, topbar and widgets; share anything else as its own code');
  const out = {};
  const part = (key) => Object.assign({}, ctx, { path: join(ctx.path, key) });
  for (const key of ['theme', 'bg', 'topbar']) {
    if (data[key] === undefined) continue;
    const res = isObject(data[key]) ? CHECKS[key](data[key], part(key)) : (fail(ctx.report, key, 'bad_part', key + ' is an object'), null);
    if (!res) return null;
    out[key] = res;
  }
  if (Array.isArray(data.pages)) {
    out.pages = [];
    for (const [i, p] of data.pages.entries()) {
      const page = isObject(p) ? p : {};
      const res = checkPage(isObject(page.data) ? page.data : {}, part('pages[' + i + '].data'));
      if (!res) return null;
      out.pages.push({ name: String(page.name || '').slice(0, 40), data: res });
    }
  }
  if (Array.isArray(data.decks)) {
    if (data.decks.length > PresetShare.BUNDLE_MAX_DECKS) {
      note(ctx.report, { path: 'decks', issue: 'dropped', was: data.decks.length + ' decks', why: 'at most ' + PresetShare.BUNDLE_MAX_DECKS });
    }
    out.decks = [];
    for (const [i, d] of data.decks.slice(0, PresetShare.BUNDLE_MAX_DECKS).entries()) {
      const deck = Object.assign({}, isObject(d) ? d : {});
      if (deck.widgets !== undefined) {
        note(ctx.report, { path: 'decks[' + i + '].widgets', issue: 'dropped', was: 'widgets', why: 'in a package, widgets go in the package\'s own "widgets"' });
        delete deck.widgets;
      }
      const res = checkDeck(deck, part('decks[' + i + ']'));
      if (!res) return null;
      out.decks.push(res);
    }
  }
  const widgets = checkWidgetList(data.widgets, ctx, PresetShare.BUNDLE_MAX_WIDGETS, 'widgets');
  if (widgets === null) return null;
  if (widgets) out.widgets = widgets;
  if (!Object.keys(out).length) { fail(ctx.report, 'data', 'empty_package', 'A package needs at least one part.'); return null; }
  return out;
}

function defaultName(kind, data) {
  const fromData = isObject(data) && (data.name || (isObject(data.manifest) && data.manifest.name));
  return String(fromData || ('AI ' + kind)).trim();
}

// → {ok:true, code, kind, name, report, critique} or {ok:false, error, hint?, report}.
function buildPreset(kind, name, data, deps) {
  const report = createReport();
  if (kind === 'sounds') return { ok: false, error: 'sounds_unsupported', hint: SOUNDS_HINT, report: summarize(report) };
  const check = CHECKS[kind];
  if (!check) return { ok: false, error: 'unknown_kind', hint: 'kind is one of ' + Object.keys(CHECKS).join(', '), report: summarize(report) };
  if (!isObject(data)) return { ok: false, error: 'bad_data', hint: 'data is a JSON object (preset_reference ' + kind + ')', report: summarize(report) };
  const out = check(data, { report, deps, path: '' });
  if (!out || report.errors.length) {
    const first = report.errors[0] || { error: 'invalid' };
    return { ok: false, error: first.error, hint: first.hint, report: summarize(report) };
  }
  const label = String(name || '').trim() || defaultName(kind, data);
  const code = PresetShare.encodePreset(kind, label, out, { exportedAt: new Date().toISOString(), appVersion: deps.appVersion || '' });
  // The import refuses a code it cannot decode (size cap included): prove it decodes.
  const decoded = PresetShare.decodePreset(code);
  if (!decoded || decoded.kind !== kind) {
    return { ok: false, error: 'too_large', hint: 'The code must stay under ' + (PresetShare.MAX_CODE_BYTES / 1048576) + ' MB: use fewer or smaller images and files.', report: summarize(report) };
  }
  return { ok: true, code, kind, name: decoded.name, report: summarize(report), critique: critiquePreset(kind, out, deps) };
}

// The create_preset tool call: `data` arrives as a JSON STRING (one schema that
// every provider accepts), an object is tolerated. `pictures`: the ones the
// user attached to this message, which the data names as "attached:N". Opens
// the import window only on success; never applies anything.
function runCreatePreset(args, deps, pictures = []) {
  const a = isObject(args) ? args : {};
  const clientActions = [];
  let data = a.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (err) {
      return { fnResult: { ok: false, error: 'bad_json', hint: String(err && err.message || err).slice(0, 160) }, clientActions };
    }
  }
  const placed = resolvePictures(data, pictures);
  const problem = pictureProblem(placed);
  if (problem) return { fnResult: problem, clientActions };
  const kind = String(a.kind || '').trim();
  const built = buildPreset(kind, a.name, placed.value, deps);
  if (!built.ok) {
    return { fnResult: { ok: false, error: built.error, hint: built.hint, report: built.report }, clientActions };
  }
  // `created`: a later create_preset in the same reply replaces this one (js/ai.js).
  clientActions.push({ action: 'marketplace_open_import', args: { code: built.code, created: true } });
  const changes = built.report.dropped + built.report.changed;
  const fixes = built.critique.fix;
  return {
    fnResult: {
      ok: true, kind: built.kind, name: built.name, report: built.report, critique: built.critique,
      note: 'The import window opens with this ' + built.kind + '; the user reviews and confirms it there.'
        + (changes ? ' The import will drop or change ' + changes + ' thing(s) listed in report: tell the user, or fix them and call create_preset again.' : '')
        + (fixes ? ' critique lists ' + fixes + ' fix item(s): correct them and call create_preset again before telling the user (in the same reply, the new code replaces this one).' : ''),
    },
    clientActions,
    code: built.code,
  };
}

function runPresetReference(args, deps) {
  return presetReference(String((isObject(args) && args.kind) || '').trim(), deps);
}

// create_widget installs straight away, so its critique comes from a dry run of
// the same files as a widget share code: the Store rules the import window would
// apply, and the code the design check reads. → {critique, code} or null.
function critiqueWidget(id, files, deps) {
  const built = buildPreset('widget', id, { id, files }, deps);
  return built.ok ? { critique: built.critique, code: built.code } : null;
}

module.exports = { buildPreset, critiqueWidget, runCreatePreset, runPresetReference, presetReference, CHECKS, SOUNDS_HINT };
