'use strict';

// Dry run for a Deck profile share code (kind deck). The profile goes through
// sanitizeDeckProfile, the one gate every shared deck passes on export and on
// import (local-only actions removed, every action re-validated, folders capped
// at DECK_MAX_FOLDER_DEPTH). The code carries the SANITIZED profile, exactly as
// the app's own export writes it, so nothing local-only ever travels in it.
//
// AI-friendly input: a key icon may be a bare emoji string, or
// {type:'svg', value:'<svg…>'} which becomes an image data URI after the same
// SVG safety check icon packs use; "pages" may sit at the top instead of in "root".

const DeckModel = require('./js/deck-model.js');
const DeckActions = require('./js/deck-actions.js');
const PresetShare = require('./js/preset-share.js');
const IconPacks = require('./icon-packs.js');
const { note, fail, diffValue, isObject } = require('./ai-preset-diff.js');
const { knownFields, join } = require('./ai-preset-checks.js');
const { checkWidgetList } = require('./ai-preset-packages.js');

const DECK_DEPS = Object.freeze({ model: DeckModel, actions: DeckActions });
const LOCAL_ONLY = ['runScript', 'typeText'];
const PROFILE_FIELDS = ['name', 'cols', 'rows', 'look', 'root', 'widgets'];
const SLOTS_PER_PAGE = DeckModel.DECK_MAX * DeckModel.DECK_MAX;
const SEE = 'see preset_reference deck';

function convertIcon(icon, path, ctx) {
  if (typeof icon === 'string') return { type: 'emoji', value: icon };
  if (!isObject(icon) || icon.type !== 'svg') return icon;
  const problem = IconPacks.svgProblem(String(icon.value || ''));
  if (problem) { note(ctx.report, { path, issue: 'dropped', was: 'svg', why: 'svg rejected: ' + problem }); return undefined; }
  return { type: 'image', value: 'data:image/svg+xml;base64,' + Buffer.from(String(icon.value), 'utf8').toString('base64'), fit: icon.fit || 'contain' };
}

function convertFolder(folder, path, ctx) {
  if (!isObject(folder) || !Array.isArray(folder.pages)) return;
  folder.pages.forEach((page, i) => {
    if (!isObject(page) || !Array.isArray(page.keys)) return;
    page.keys.forEach((key, j) => {
      if (!isObject(key)) return;
      const at = path + '.pages[' + i + '].keys[' + j + ']';
      if (key.icon !== undefined) key.icon = convertIcon(key.icon, at + '.icon', ctx);
      if (key.kind === 'folder') convertFolder(key.folder, at + '.folder', ctx);
    });
  });
}

// ── report ─────────────────────────────────────────────────────────────────

function keyWhy(raw, index) {
  if (index >= SLOTS_PER_PAGE) return 'a page holds at most ' + SLOTS_PER_PAGE + ' keys';
  if (!isObject(raw) || !['action', 'folder', 'slider'].includes(raw.kind)) return 'kind is action, folder or slider';
  if (raw.kind === 'slider') return 'slider.target is one of ' + DeckModel.SLIDER_TARGETS.join(', ');
  return '';
}

function fieldWhy(path) {
  const field = path.split('.').pop();
  if (field === 'label') return 'the key text is "title" (40 characters)';
  if (/\.state\b/.test(path)) return 'state.source is one of the stateSources of deck_action_catalog';
  if (/\.live\b/.test(path)) return 'live.source is one of the liveSources of deck_action_catalog';
  return SEE;
}

function actionWhy(type) {
  if (LOCAL_ONLY.includes(type)) return 'runScript and typeText are local-only: they never travel in a shared code';
  return DeckActions.actionSpec(type)
    ? 'bad or missing params for ' + type + ' (see deck_action_catalog)'
    : 'unknown action type "' + String(type) + '" (see deck_action_catalog)';
}

// Why a step param came back empty: the sharer's own paths, numbers and device
// ids never travel in a code, the receiver fills them in after import.
function personalWhy(type, path) {
  const field = path.split('.').pop();
  if (type === 'playSound' && field === 'file') return 'only a sound-pack clip (packs/<pack>/<clip>.<ext>) travels in a shared code';
  if ((DeckActions.PERSONAL_PARAMS[type] || []).includes(field) || (type === 'openApp' && field === 'args')) {
    return field + ' is personal to one PC or account: a shared code carries it empty and the receiver sets it after import';
  }
  return 'see deck_action_catalog';
}

// Steps are checked one by one with the same validateAction the sanitizer uses,
// so a dropped step is named instead of shifting the ones after it.
function diffTrigger(raw, out, path, ctx) {
  const steps = isObject(raw) && Array.isArray(raw.steps)
    ? raw.steps.map((s, i) => ({ action: s && s.action, at: path + '.steps[' + i + '].action' }))
    : [{ action: raw, at: path }];
  const kept = DeckActions.triggerSteps(out);
  let next = 0;
  for (const step of steps) {
    const type = isObject(step.action) ? step.action.type : step.action;
    if (LOCAL_ONLY.includes(type) || !DeckActions.validateAction(step.action)) {
      note(ctx.report, { path: step.at, issue: 'dropped', was: step.action, why: actionWhy(type) });
      continue;
    }
    const outStep = kept[next++];
    diffValue(step.action, outStep && outStep.action, step.at, ctx.report, (p) => personalWhy(type, p));
  }
}

function diffTriggers(raw, out, path, ctx) {
  if (!isObject(raw)) { diffValue(raw, out, path, ctx.report, fieldWhy); return; }
  for (const name of Object.keys(raw)) {
    const at = path + '.' + name;
    if (!DeckModel.KEY_TRIGGERS.includes(name)) {
      note(ctx.report, { path: at, issue: 'dropped', was: raw[name], why: 'trigger slots: ' + DeckModel.KEY_TRIGGERS.join(', ') });
    } else {
      diffTrigger(raw[name], out && out[name], at, ctx);
    }
  }
}

function diffKey(raw, out, path, index, ctx) {
  if (raw === null || raw === undefined) return;
  if (!out) { note(ctx.report, { path, issue: 'dropped', was: raw, why: keyWhy(raw, index) }); return; }
  for (const field of Object.keys(raw)) {
    const at = path + '.' + field;
    if (field === 'id' || field === 'kind') continue;
    if (field === 'triggers') diffTriggers(raw.triggers, out.triggers, at, ctx);
    else if (field === 'folder') diffFolder(raw.folder, out.folder, at, ctx);
    else diffValue(raw[field], out[field], at, ctx.report, fieldWhy);
  }
}

function diffFolder(raw, out, path, ctx) {
  if (!isObject(raw) || !Array.isArray(raw.pages)) return;
  raw.pages.forEach((page, i) => {
    const outPage = out && Array.isArray(out.pages) ? out.pages[i] : null;
    const keys = isObject(page) && Array.isArray(page.keys) ? page.keys : [];
    keys.forEach((key, j) => diffKey(key, outPage && outPage.keys[j], path + '.pages[' + i + '].keys[' + j + ']', j, ctx));
  });
}

function checkDeck(data, ctx) {
  const input = knownFields(JSON.parse(JSON.stringify(data)), PROFILE_FIELDS.concat('pages'), ctx, 'not a profile field (' + SEE + ')');
  if (!input.root && Array.isArray(input.pages)) input.root = { pages: input.pages };
  delete input.pages;
  convertFolder(input.root, join(ctx.path, 'root'), ctx);
  // sanitizeDeckProfile caps folder depth IN PLACE: give it its own copy so the
  // report still sees what the model wrote.
  const out = PresetShare.sanitizeDeckProfile(JSON.parse(JSON.stringify(input)), DECK_DEPS);
  if (!out) {
    fail(ctx.report, join(ctx.path, 'root'), 'bad_profile', 'A deck needs "root": {"pages": [{"keys": [...]}]} (' + SEE + ').');
    return null;
  }
  for (const key of ['name', 'cols', 'rows', 'look']) {
    diffValue(input[key], out[key], join(ctx.path, key), ctx.report, () => (key === 'look' ? SEE : 'cols and rows are '
      + DeckModel.DECK_MIN + '-' + DeckModel.DECK_MAX));
  }
  diffFolder(input.root, out.root, join(ctx.path, 'root'), ctx);
  if (!PresetShare.countProfileKeys(out)) {
    fail(ctx.report, join(ctx.path, 'root'), 'no_keys', 'No key survived the import (' + SEE + ').');
    return null;
  }
  const widgets = checkWidgetList(input.widgets, ctx, PresetShare.DECK_EMBED_MAX_WIDGETS, 'widgets');
  if (widgets === null) return null;
  return widgets ? Object.assign(out, { widgets }) : out;
}

module.exports = { checkDeck, DECK_DEPS };
