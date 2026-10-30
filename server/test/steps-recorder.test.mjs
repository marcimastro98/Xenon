// The steps recorder: steps-doc.js (the document), steps-recorder.js (the
// state around the engine) and capabilities/steps.js (Deck, Bit). Pinned here:
// other apps' names are escaped in both documents; typing is noted on the step
// before it, never what was typed; the engine's events are validated; a
// recording with no click leaves no folder; the document is written under a
// temporary name first; "open" and "reveal" act on the last document only; the
// SSE carries counts, never a step's text; catalog, AI and strings line up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Doc = require('../steps-doc.js');
const { createStepsRecorder, stampOf } = require('../steps-recorder.js');
const stepsCap = require('../capabilities/steps.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const WORDS = {
  steps_doc_title: 'Steps', steps_doc_made: 'Recorded with Xenon on {date}', steps_one: '1 step', steps_count: '{n} steps',
  steps_step: 'Step {n}', steps_sentence: '{action}.',
  steps_click_named: 'Click "{name}"', steps_click_spot: 'Click the circled spot',
  steps_right_named: 'Right-click "{name}"', steps_right_spot: 'Right-click the circled spot',
  steps_double_named: 'Double-click "{name}"', steps_double_spot: 'Double-click the circled spot',
  steps_type_after: 'Then type the text.', steps_in_app: 'In {app}',
  steps_ended_full: 'The recording stopped at 100 steps.', steps_ended_idle: 'The recording stopped after 20 minutes without clicks.',
  steps_role_button: 'button', steps_role_field: 'text field', steps_role_checkbox: 'checkbox',
};

const ev = (n, extra = {}) => ({ event: 'step', n, file: `step-${String(n).padStart(3, '0')}.jpg`, width: 1600, height: 900, right: false, app: 'chrome.exe', name: '', role: '', typedBefore: false, ...extra });

test('a step is validated: number, file name, role and sizes; names are cleaned', () => {
  assert.equal(Doc.normalizeStep({ ...ev(1), file: '../x.jpg' }), null);
  assert.equal(Doc.normalizeStep({ ...ev(0) }), null);
  assert.equal(Doc.normalizeStep({ ...ev(101), file: 'step-101.jpg' }), null);
  assert.equal(Doc.normalizeStep(null), null);
  const s = Doc.normalizeStep(ev(2, { name: 'Save\nreport\u0007', role: 'wizard', width: -1, app: 'Code.EXE', right: 'yes' }));
  assert.equal(s.name, 'Save report');
  assert.equal(s.role, '');
  assert.equal(s.width, 0);
  assert.equal(s.app, 'Code');
  assert.equal(s.right, false);
  assert.equal(Doc.normalizeStep(ev(3, { name: 'x'.repeat(200) })).name.length, 80);
});

test('the sentence names what was clicked, its kind, the button; typing goes to the step before', () => {
  const steps = Doc.withTyping([
    Doc.normalizeStep(ev(1, { name: 'Save report', role: 'button', typedBefore: true })),
    Doc.normalizeStep(ev(2, { role: 'field' })),
    Doc.normalizeStep(ev(3, { name: 'Remember me', role: 'checkbox', typedBefore: true, right: true })),
  ], true);
  assert.equal(Doc.stepText(steps[0], WORDS), 'Click "Save report" (button).');
  assert.equal(Doc.stepText(steps[1], WORDS), 'Click the circled spot (text field). Then type the text.');
  assert.equal(Doc.stepText(steps[2], WORDS), 'Right-click "Remember me" (checkbox). Then type the text.');
  steps[0].double = true;
  assert.equal(Doc.stepText(steps[0], WORDS), 'Double-click "Save report" (button).');
  // Chinese and Japanese end with their own full stop.
  assert.equal(Doc.stepText({ ...steps[0], double: false }, { ...WORDS, steps_sentence: '{action}。' }), 'Click "Save report" (button)。');
});

test('the HTML escapes other apps\' names, carries the pictures, and fetches nothing', () => {
  const steps = Doc.withTyping([Doc.normalizeStep(ev(1, { name: '<img src=x onerror=alert(1)>', app: 'a"b.exe' })), Doc.normalizeStep(ev(2))], false);
  const html = Doc.toHtml({ steps, words: WORDS, when: '27 Oct', reason: 'full', lang: 'it', images: { 'step-001.jpg': 'QUJD' } });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('In a&quot;b'));
  assert.ok(html.includes('src="data:image/jpeg;base64,QUJD"'));
  // The second picture was not read: its step stays, without an image.
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.match(html, /<html lang="it">/);
  assert.ok(html.includes('2 steps'));
  assert.ok(html.includes('The recording stopped at 100 steps.'));
  assert.ok(!/<script/i.test(html));
  assert.match(Doc.toHtml({ steps, words: WORDS, when: '', reason: 'stopped', lang: 'x" onload="y', images: {} }), /<html lang="en">/);
});

test('the Markdown escapes syntax in names and links the pictures beside it', () => {
  const steps = Doc.withTyping([Doc.normalizeStep(ev(1, { name: '**Bold** [link](http://x)', role: 'button' }))], false);
  const md = Doc.toMarkdown({ steps, words: WORDS, when: '27 Oct', reason: 'idle' });
  assert.ok(md.includes('\\*\\*Bold\\*\\* \\[link\\]\\(http://x\\)'));
  assert.ok(md.includes('](step-001.jpg)'));
  assert.ok(md.includes('1 step'));
  assert.ok(md.includes('without clicks'));
});

function fakeFs() {
  const files = new Map();
  const dirs = new Set();
  const log = [];
  return {
    files, dirs, log,
    mkdir: async (d) => { dirs.add(d); },
    readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile: async (p, data) => { log.push(['write', path.basename(p)]); files.set(p, Buffer.from(data)); },
    rename: async (a, b) => { log.push(['rename', path.basename(a), path.basename(b)]); files.set(b, files.get(a)); files.delete(a); },
    rmdir: async (d) => { log.push(['rmdir']); dirs.delete(d); },
  };
}

function setup({ reply = { ok: true, steps: true }, available = true, remember, exists } = {}) {
  const listeners = [];
  const requests = [];
  const changes = [];
  const saved = [];
  const opened = [];
  const revealed = [];
  const fsx = fakeFs();
  const host = {
    available: () => available,
    onEvent: (fn) => listeners.push(fn),
    request: async (cmd, body) => {
      requests.push({ cmd, body });
      if (body.action === 'stop') {
        // The engine reports the end before it answers.
        emit({ event: 'steps_ended', reason: 'stopped', count: 0, typed: false });
        return { ok: true, steps: false };
      }
      return typeof reply === 'function' ? reply(body) : reply;
    },
  };
  const emit = (e) => listeners.forEach(fn => fn(e));
  const rec = createStepsRecorder({
    host, root: async () => 'C:\\Users\\u\\Documents', ...fsx,
    words: async () => WORDS, badge: async () => 'Steps: {n}', lang: () => 'en', when: () => 'today',
    openFile: (f) => opened.push(f), reveal: (f) => revealed.push(f), now: () => new Date(2026, 9, 27, 9, 5, 7).getTime(),
    onChange: (s) => changes.push(s), onSaved: (s) => saved.push(s),
    ...(remember ? { remember } : {}), ...(exists ? { exists } : {}),
  });
  return { rec, emit, requests, changes, saved, opened, revealed, fsx };
}

test('a recording writes steps.html and steps.md, each through a temporary name', async () => {
  const t = setup();
  assert.deepEqual(await t.rec.start(), { ok: true, recording: true });
  const dir = path.join('C:\\Users\\u\\Documents', 'Xenon', 'Steps', '2026-10-27 09-05-07');
  assert.deepEqual(t.requests[0], { cmd: 'steps', body: { action: 'start', dir, badge: 'Steps: {n}' } });
  t.fsx.files.set(path.join(dir, 'step-001.jpg'), Buffer.from('ABC'));
  t.emit(ev(1, { name: 'Save report', role: 'button' }));
  t.emit(ev(1, { name: 'again' }));
  t.emit(ev(2, { typedBefore: true }));
  t.emit({ event: 'step_double', n: 2 });
  t.emit({ event: 'step', n: 'x' });
  assert.equal(t.rec.status().count, 2);
  const out = await t.rec.stop();
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.folder, '2026-10-27 09-05-07');
  assert.deepEqual(out.steps.map(s => s.text), ['Click "Save report" (button). Then type the text.', 'Double-click the circled spot.']);
  assert.deepEqual(t.fsx.log, [
    ['write', 'steps.html.part'], ['rename', 'steps.html.part', 'steps.html'],
    ['write', 'steps.md.part'], ['rename', 'steps.md.part', 'steps.md'],
  ]);
  const html = t.fsx.files.get(path.join(dir, 'steps.html')).toString();
  assert.ok(html.includes(Buffer.from('ABC').toString('base64')));
  // What leaves over SSE: counts and the reason, never a step's text.
  assert.deepEqual(t.saved, [{ count: 2, reason: 'stopped' }]);
  for (const c of t.changes) assert.ok(!JSON.stringify(c).includes('Save report'));
  assert.deepEqual(t.changes.at(-1), { on: false, reason: 'stopped', count: 2 });
  assert.deepEqual(await t.rec.open(), { ok: true, opened: true, folder: '2026-10-27 09-05-07' });
  assert.deepEqual(t.opened, [path.join(dir, 'steps.html')]);
  assert.equal((await t.rec.reveal()).shown, true);
  assert.equal(t.rec.status().on, false);
});

test('no click leaves no folder; an end by itself keeps its reason; the engine dying writes what it has', async () => {
  const t = setup();
  await t.rec.start();
  assert.deepEqual(await t.rec.stop(), { ok: false, error: 'no_steps', reason: 'stopped' });
  assert.equal(t.fsx.dirs.size, 0);
  assert.deepEqual(await t.rec.open(), { ok: false, error: 'no_file' });
  assert.equal(t.changes.at(-1).error, 'no_steps');

  const u = setup();
  await u.rec.start();
  u.emit(ev(1));
  u.emit({ event: 'steps_ended', reason: 'closed', count: 1, typed: true });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(u.saved, [{ count: 1, reason: 'closed' }]);

  const v = setup();
  await v.rec.start();
  v.emit(ev(1));
  v.emit({ event: 'engine_exited' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(v.saved[0].reason, 'engine_exited');
  // Events after the end are ignored.
  v.emit(ev(2));
  assert.equal(v.rec.status().on, false);
});

test('start refuses a second one, passes known engine errors, and removes the folder it made', async () => {
  const t = setup();
  await t.rec.start();
  assert.deepEqual(await t.rec.start(), { ok: false, error: 'running' });
  const h = setup({ reply: { ok: false, error: 'hook_failed' } });
  assert.deepEqual(await h.rec.start(), { ok: false, error: 'hook_failed' });
  assert.equal(h.fsx.dirs.size, 0);
  assert.deepEqual(await setup({ reply: { ok: false, error: 'weird' } }).rec.start(), { ok: false, error: 'failed' });
  assert.deepEqual(await setup({ reply: { ok: false, error: 'already_running' } }).rec.start(), { ok: false, error: 'running' });
  assert.deepEqual(await setup({ available: false }).rec.start(), { ok: false, error: 'unavailable' });
  assert.deepEqual(await setup().rec.stop(), { ok: false, error: 'not_recording' });
  assert.equal(stampOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03-04-05');
});

test('the capability picks the mode; the catalog, the runner and the AI line up', async () => {
  const calls = [];
  const fake = { start: async () => (calls.push('start'), { ok: true }), stop: async () => (calls.push('stop'), { ok: true }), toggle: async () => (calls.push('toggle'), { ok: true }), open: () => (calls.push('open'), { ok: true }), reveal: () => (calls.push('reveal'), { ok: true }) };
  const capture = { host: { available: () => true }, steps: () => fake };
  for (const mode of ['start', 'stop', 'open', 'reveal', 'erase', undefined]) await stepsCap.run({ capture }, { mode });
  assert.deepEqual(calls, ['start', 'stop', 'open', 'reveal', 'toggle', 'toggle']);
  assert.deepEqual(await stepsCap.run({ capture: { host: { available: () => false }, steps: () => fake } }, {}), { ok: false, error: 'unavailable' });
  const c = CAPABILITIES.find(x => x.type === 'steps');
  assert.equal(c.group, 'capture');
  assert.equal(c.capability.risk, 'sensitive');
  assert.deepEqual(c.params[0].options, stepsCap.MODES.slice());
  assert.ok(aiFunctions({ capture: true }).some(f => f.name === 'record_steps'));
  assert.deepEqual(aiAction('record_steps', { mode: 'stop', x: 1 }), { type: 'steps', mode: 'stop' });
  assert.equal((await createCapabilities({ capture }).run({ type: 'steps', mode: 'open' })).ok, true);
});

test('the step sentences reach the AI turn only, never the action result a phone can get', async () => {
  const said = [{ n: 1, text: 'Click "Save"', app: 'Notes' }];
  const fake = { stop: async () => ({ ok: true, saved: true, count: 1, steps: said }), toggle: async () => ({ ok: false, error: 'not_recording' }) };
  const capture = { host: { available: () => true }, steps: () => fake };
  const r = await stepsCap.run({ capture }, { mode: 'stop' });
  assert.deepEqual(r, { ok: true, saved: true, count: 1 });
  assert.deepEqual(stepsCap.takeSteps(), said);
  assert.equal(stepsCap.takeSteps(), null, 'once');
  await stepsCap.run({ capture }, { mode: 'stop' });
  assert.equal(stepsCap.takeSteps(Date.now() + 31000), null, 'not after 30 s');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /fnName === 'record_steps' && fnResult && fnResult\.ok === true && fnResult\.saved === true\) \{\n\s+const steps = require\('\.\/capabilities\/steps\.js'\)\.takeSteps\(\);/);
});

test('the strings exist in 11 languages, keep their placeholders, and the Deck icon is there', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const keys = [...Doc.ALL_WORDS, 'deck_act_steps', 'deck_opt_steps_open', 'steps_badge', 'steps_on', 'steps_on_msg', 'steps_saved', 'steps_none', 'steps_failed', 'steps_cut_full', 'steps_cut_idle'];
  for (const k of keys) {
    const found = [...i18n.matchAll(new RegExp(`\\b${k}: '((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map(m => m[1]);
    assert.equal(found.length, 11, k);
    for (const holder of ['{name}', '{n}', '{app}', '{date}', '{action}']) {
      if (found[0].includes(holder)) for (const v of found) assert.ok(v.includes(holder), `${k}: ${v}`);
    }
    for (const v of found) assert.ok(!v.includes('\u2014'), `${k} has an em-dash`);
  }
  assert.match(readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8'), /\n {6}steps: _ai\(/);
});

// "Open" / "Show" after a restart: the last document is remembered (capture-last.js),
// read back only when it looks like one this recorder wrote, and only while it is on disk.
test('the last document survives a restart, checked and only while it is on disk', async () => {
  const kept = [];
  const t = setup({ remember: { load: async () => null, save: (v) => kept.push(v) } });
  await t.rec.start();
  t.fsx.files.set(path.join('C:\\Users\\u\\Documents', 'Xenon', 'Steps', '2026-10-27 09-05-07', 'step-001.jpg'), Buffer.from('A'));
  t.emit(ev(1, { name: 'Save', role: 'button' }));
  await t.rec.stop();
  assert.equal(kept.length, 1);
  const doc = kept[0];
  assert.equal(path.basename(doc.html), 'steps.html');

  let there = true;
  const after = setup({ remember: { load: async () => doc, save: () => {} }, exists: async () => there });
  assert.deepEqual(await after.rec.open(), { ok: true, opened: true, folder: '2026-10-27 09-05-07' });
  assert.deepEqual(after.opened, [doc.html]);
  there = false;
  assert.deepEqual(await after.rec.reveal(), { ok: false, error: 'no_file' });

  for (const bad of [
    { ...doc, html: 'C:\\Windows\\system32\\calc.exe' },
    { ...doc, name: 'other' },
    { ...doc, html: 'steps.html', dir: '.' },
    { dir: 1, html: doc.html, name: doc.name },
    'nope',
  ]) {
    const x = setup({ remember: { load: async () => bad, save: () => {} } });
    assert.deepEqual(await x.rec.open(), { ok: false, error: 'no_file' }, JSON.stringify(bad));
    assert.equal(x.opened.length, 0);
  }
  const broken = setup({ remember: { load: async () => { throw new Error('read'); }, save: () => {} } });
  assert.deepEqual(await broken.rec.open(), { ok: false, error: 'no_file' });
});
