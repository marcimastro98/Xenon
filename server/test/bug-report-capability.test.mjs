// capabilities/bug-report.js: the bug report key for the Deck and Bit. Pinned
// here: "make" passes the seconds, "reveal" shows the last package, no engine is
// "unavailable"; the catalog, the runner and the AI line up; it is NOT a widget
// action (a widget would bundle the screen and the PC's details); the server
// wires it to the replay, the folders and the notice without a path; strings,
// Settings rows and the Deck icon exist in 11 languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cap = require('../capabilities/bug-report.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { SDK_ACTION_CATEGORIES } = require('../sdk-widgets.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function deps({ available = true } = {}) {
  const log = [];
  const maker = {
    make: async (o) => { log.push(['make', o]); return { ok: true, saved: true, name: 'Bug report Code x.zip' }; },
    reveal: async () => { log.push(['reveal']); return { ok: true, shown: true, name: 'Bug report Code x.zip' }; },
  };
  return { d: { capture: { host: { available: () => available }, bugReport: () => maker } }, log };
}

test('make passes the seconds, reveal shows the last one, no engine is unavailable', async () => {
  const { d, log } = deps();
  assert.equal((await cap.run(d, { seconds: '60' })).saved, true);
  assert.equal((await cap.run(d, { mode: 'reveal' })).shown, true);
  assert.equal((await cap.run(d, { mode: 'nonsense' })).saved, true, 'anything else makes one');
  assert.deepEqual(log, [['make', { seconds: '60' }], ['reveal'], ['make', { seconds: undefined }]]);
  assert.deepEqual(await cap.run(deps({ available: false }).d, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(await cap.run({ capture: { host: { available: () => true } } }, {}), { ok: false, error: 'unavailable' });
});

test('the catalog entry, the runner and the AI function line up; widgets never get it', async () => {
  const c = CAPABILITIES.find((x) => x.type === 'bugReport');
  assert.equal(c.group, 'capture');
  assert.equal(c.capability.risk, 'sensitive');
  assert.equal(c.capability.requires, 'capture');
  assert.deepEqual(c.params.find((p) => p.name === 'mode').options, cap.MODES.slice());
  const BR = require('../bug-report.js');
  assert.deepEqual(c.params.find((p) => p.name === 'seconds').options.map(Number).sort((a, b) => a - b), BR.SECONDS.slice());
  assert.equal(c.params.find((p) => p.name === 'seconds').options[0], String(BR.DEFAULT_SECONDS), 'the default first');
  assert.ok(aiFunctions({ capture: true }).some((f) => f.name === 'make_bug_report'));
  assert.ok(!aiFunctions({ capture: false }).some((f) => f.name === 'make_bug_report'));
  assert.deepEqual(aiAction('make_bug_report', { seconds: '10', extra: 1 }), { type: 'bugReport', seconds: '10' });
  const { d } = deps();
  assert.equal((await createCapabilities({ capture: d.capture }).run({ type: 'bugReport' })).saved, true);
  for (const list of Object.values(SDK_ACTION_CATEGORIES)) assert.ok(!list.includes('bugReport'));
  assert.doesNotMatch(read('../js/custom-widget.js'), /bugReport/);
});

test('the server wires the replay, both folders and a notice without a path', () => {
  const SERVER = read('../server.js');
  assert.match(SERVER, /bugReport: \(\) => _bugReport,/);
  const at = SERVER.indexOf('const _bugReport = createBugReport({');
  const block = SERVER.slice(at, SERVER.indexOf('\n});', at));
  for (const want of ["replay: () => _replay", 'captureOptions().bugFolder', 'captureOptions().bugLogs', "defaultCaptureFolder('bugreport')", "kind: 'bugreport'"]) {
    assert.ok(block.includes(want), want);
  }
  assert.ok(!/hostname/.test(block), 'never the PC name');
  assert.ok(!/\bfile\b[^)]*broadcastSSE|saved:|path:/.test(block.slice(block.indexOf('onSaved'))), 'no path on the wire');
  assert.ok(SERVER.indexOf('const _bugReport = createBugReport') > SERVER.indexOf('const _replay = createReplay'), 'after the replay it reads');
  assert.match(SERVER, /if \(kind === 'bugreport'\) return path\.join\(await documentsRoot\(\), 'Xenon', 'Bug reports'\);/);
  assert.match(SERVER, /defaultBugFolder: await defaultCaptureFolder\('bugreport'\)/);
});

test('strings, the Settings rows and the Deck icon exist, in 11 languages', () => {
  const i18n = read('../js/i18n.js');
  for (const k of ['deck_act_bugReport', 'deck_opt_bug_make', 'deck_param_bug_seconds', 'deck_opt_bug_10', 'deck_opt_bug_30', 'deck_opt_bug_60',
    'bug_saved', 'bug_video', 'bug_no_video', 'bug_no_video_now', 'bug_no_shot', 'bug_logs', 'bug_log_one', 'bug_logs_missing', 'bug_folder_missing',
    'settings_bug_logs', 'settings_bug_logs_hint', 'settings_bug_logs_none', 'settings_bug_logs_clear', 'bug_folder_title', 'bug_logs_title',
    'deck_err_busy', 'deck_err_too_big', 'deck_err_write_failed']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
  assert.match(read('../js/deck-editor.js'), /bugReport: _ai\(/);
  const html = read('../index.html');
  assert.ok(html.includes('data-folder-for="bugreport"') && html.includes('data-folder-for="buglogs"'));
  const errs = require('../js/deck-error-text.js');
  const tt = (_k, f) => f;
  for (const code of ['busy', 'too_big', 'write_failed']) assert.notEqual(errs.describe(code, tt), code, code);
});
