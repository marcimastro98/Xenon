'use strict';
// ── Xenon for theme and background authors: the MCP's share-code ops ───────
// A theme, an animated background, a page, a Deck profile, a top bar, an icon
// pack or a package of them is a share code, not an installed package. These
// ops are Bit's preset_reference and create_preset (ai/ai-presets.js) behind
// the MCP: the same rules, the same checks, the same critique. Nothing is
// applied here: import_preset opens the dashboard's import window with the
// code, and the person reviews and confirms it there, exactly as with a code
// pasted by hand. Widgets and coded Ambient scenes keep their folder tools
// (mcp-dev-tools.js).
//
// The code never rides the SSE broadcast (it reaches paired phones too, and a
// code with pictures runs to megabytes): the question carries no data, and the
// dashboard that takes it gets the code in the answer to its loopback report.

const aiPresets = require('../ai/ai-presets.js');

const KINDS = Object.freeze(['theme', 'bg', 'bundle', 'page', 'deck', 'topbar', 'icons', 'ambient-layout']);
// A code this long or shorter comes back with check_preset, to share or paste by hand.
const CODE_SHOWN_MAX = 64 * 1024;
const NEXT = 'check_preset runs the checks; import_preset opens it in Xenon for the person to confirm.';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function kindOf(args) {
  const kind = String(args?.kind || '').trim();
  return KINDS.includes(kind) ? kind : null;
}

// `data` as the bridge sends it: an object, or the JSON text of one.
function dataOf(args) {
  const d = args?.data;
  if (isObject(d)) return { data: d };
  if (typeof d !== 'string') return { error: { ok: false, error: 'bad_data', hint: 'data is a JSON object: see preset_reference for the kind.' } };
  try {
    const parsed = JSON.parse(d);
    return isObject(parsed) ? { data: parsed } : { error: { ok: false, error: 'bad_data', hint: 'data is a JSON object.' } };
  } catch (e) {
    return { error: { ok: false, error: 'bad_json', hint: String(e?.message || e).slice(0, 160) } };
  }
}

const badKind = () => ({ ok: false, error: 'unknown_kind', hint: 'kind is one of ' + KINDS.join(', ') + '. Widgets and coded Ambient scenes: new_widget.' });

function build(args, deps) {
  const kind = kindOf(args);
  if (!kind) return { fail: badKind() };
  const d = dataOf(args);
  if (d.error) return { fail: d.error };
  const built = aiPresets.buildPreset(kind, args.name, d.data, deps.presetDeps());
  if (!built.ok) return { fail: { ok: false, error: built.error, hint: built.hint, report: built.report } };
  return { built };
}

// What to do about the findings, said once for both tools.
function adviceOf(built) {
  const changes = built.report.dropped + built.report.changed;
  const fixes = built.critique.fix;
  return [
    changes ? 'The import drops or changes ' + changes + ' thing(s) listed in report: fix them in data.' : '',
    fixes ? 'critique lists ' + fixes + ' fix item(s): correct them before showing it to the person.' : '',
  ].filter(Boolean).join(' ');
}

async function opPresetReference(args, deps) {
  const raw = String(args?.kind || '').trim();
  if (!raw) {
    const all = aiPresets.presetReference('', deps.presetDeps()).kinds || {};
    const kinds = Object.fromEntries(KINDS.map((k) => [k, all[k]]));
    return { ok: true, kinds, note: 'Call preset_reference again with one kind for its exact rules and an example. ' + NEXT };
  }
  if (!kindOf(args)) return badKind();
  return { ...aiPresets.presetReference(raw, deps.presetDeps()), next: NEXT };
}

async function opCheckPreset(args, deps) {
  const { fail, built } = build(args, deps);
  if (fail) return fail;
  const shown = built.code.length <= CODE_SHOWN_MAX;
  return {
    ok: true,
    kind: built.kind,
    name: built.name,
    report: built.report,
    critique: built.critique,
    ...(shown ? { code: built.code } : { codeNote: 'The code is ' + Math.round(built.code.length / 1024) + ' KB, too long to show: use import_preset.' }),
    note: (adviceOf(built) + ' Anyone can paste the code in Xenon: Create and share, Share & Import, Import.').trim(),
  };
}

async function opImportPreset(args, deps) {
  const { fail, built } = build(args, deps);
  if (fail) return fail;
  const opened = await deps.ask('import', { id: '', kind: built.kind }, 4000, { code: built.code });
  if (!opened) {
    return { ok: false, error: 'no_dashboard', hint: 'No Xenon dashboard is open on screen. Ask the person to open it, or give them the code from check_preset to paste in Create and share, Share & Import, Import.' };
  }
  return {
    ok: true,
    kind: built.kind,
    name: built.name,
    report: built.report,
    critique: built.critique,
    note: ('The import window is open on the dashboard: the person reviews and confirms it there. Then dashboard_screenshot shows the result. ' + adviceOf(built)).trim(),
  };
}

async function opScreenShot(_args, deps) {
  const where = await deps.ask('screen', { id: '' });
  if (!where) return { ok: false, error: 'no_dashboard', hint: 'No Xenon dashboard is open.' };
  if (where.found !== true || !where.rect) return { ok: false, error: 'not_on_screen', hint: 'The dashboard is open but hidden or minimized. Ask the person to bring it on screen.' };
  const shot = await deps.captureRect(where);
  if (!shot?.ok) return { ok: false, error: shot?.error || 'capture_failed' };
  return { ok: true, image: { mimeType: 'image/jpeg', data: shot.data }, size: { width: shot.width, height: shot.height } };
}

const LOOK_OPS = Object.freeze({
  preset_reference: opPresetReference,
  check_preset: opCheckPreset,
  import_preset: opImportPreset,
  dashboard_shot: opScreenShot,
});

module.exports = { LOOK_OPS, KINDS, CODE_SHOWN_MAX };
