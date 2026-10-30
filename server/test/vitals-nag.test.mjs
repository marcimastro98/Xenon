// Bit's actions on the PC (server/vitals-nag.js): which route each OS takes for
// the popup and the hiding, and that what Settings is told is the truth here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVitalsNag, cleanText, popupFont, POPUP_MS } = require('../vitals-nag.js');
const lc = require('../linux-collectors.js');
const dc = require('../darwin-collectors.js');

function rig({ platform = 'linux', host = false, collectors = {}, script = false } = {}) {
  const spawned = [];
  const sent = [];
  let clock = 1000;
  const nag = createVitalsNag({
    platform,
    collectors,
    spawnScript: script ? (args) => spawned.push(args) : null,
    host: { available: () => host },
    broadcast: (p) => sent.push(p),
    now: () => clock,
  });
  return { nag, spawned, sent, tick: (ms) => { clock += ms; } };
}

test('Windows: the popup is the script on one monitor, or on every one, with a font that has the script', async () => {
  const w = rig({ platform: 'win32', script: true });
  assert.deepEqual(await w.nag.popup({ text: 'stand up', mood: 'ghost', lang: 'ko', all: true }), { ok: true, reach: 'screens' });
  assert.deepEqual(w.spawned[0], ['-Text', 'stand up', '-Mood', 'ghost', '-Duration', '9', '-Font', 'Malgun Gothic', '-AllScreens']);
  await w.nag.popup({ text: 'x', mood: 'nope' });
  assert.deepEqual(w.spawned[1].slice(2, 4), ['-Mood', 'angry']);
  assert.ok(!w.spawned[1].includes('-AllScreens'));
});

test('Windows: hiding is the same script with -Minimize', async () => {
  const w = rig({ platform: 'win32', script: true });
  assert.deepEqual(await w.nag.hide({ text: 'hidden' }), { ok: true });
  assert.equal(w.spawned[0].at(-1), '-Minimize');
});

test('macOS and Linux with the Xenon app open: the popup goes to its alerts window, and a late page still gets it', async () => {
  const m = rig({ platform: 'darwin', host: true, collectors: { notify: () => assert.fail('no banner when the app can draw') } });
  assert.deepEqual(await m.nag.popup({ text: 'drink', mood: 'worried' }), { ok: true, reach: 'main' });
  assert.deepEqual(m.sent, [{ text: 'drink', mood: 'worried', until: 1000 + POPUP_MS }]);
  m.tick(POPUP_MS - 1);
  assert.equal(m.nag.current().text, 'drink');
  m.tick(1);
  assert.equal(m.nag.current(), null);
});

test('macOS and Linux with no app window: a system notification, and an honest error when even that fails', async () => {
  const calls = [];
  const ok = rig({ collectors: { notify: async (...a) => { calls.push(a); } } });
  assert.deepEqual(await ok.nag.popup({ text: 'move' }), { ok: true, reach: 'notify' });
  assert.deepEqual(calls, [['Bit', 'move']]);
  const broken = rig({ collectors: { notify: async () => { throw new Error('no notify-send'); } } });
  assert.deepEqual(await broken.nag.popup({ text: 'move' }), { ok: false, error: 'notify_failed' });
  assert.deepEqual(await rig().nag.popup({ text: 'move' }), { ok: false, error: 'unavailable' });
});

test('hiding off Windows: the collector does it, then Bit says so; each failure keeps its reason', async () => {
  const shownTexts = [];
  const ok = rig({ collectors: { hideWindows: async () => {}, notify: async (_t, line) => { shownTexts.push(line); } } });
  assert.deepEqual(await ok.nag.hide({ text: 'gone' }), { ok: true });
  assert.deepEqual(shownTexts, ['gone']);
  const fail = (code) => rig({ collectors: { hideWindows: async () => { const e = new Error(code); e.code = code; throw e; } } });
  assert.deepEqual(await fail('wayland').nag.hide({}), { ok: false, error: 'wayland' });
  assert.deepEqual(await fail('needs_wmctrl').nag.hide({}), { ok: false, error: 'needs_wmctrl' });
  assert.deepEqual(await fail('wmctrl_failed').nag.hide({}), { ok: false, error: 'failed' });
  assert.deepEqual(await rig().nag.hide({}), { ok: false, error: 'unavailable' });
});

test('capabilities: what Settings shows matches what the routes would do', async () => {
  const win = rig({ platform: 'win32', script: true });
  assert.deepEqual(await win.nag.capabilities(), { popup: 'screens', allScreens: true, minimize: { ok: true, reason: '' } });
  const gnome = rig({ collectors: { notify() {}, hideWindowsTool: async () => ({ tool: '', reason: 'wayland' }) } });
  assert.deepEqual(await gnome.nag.capabilities(), { popup: 'notify', allScreens: false, minimize: { ok: false, reason: 'wayland' } });
  const mac = rig({ platform: 'darwin', host: true, collectors: { hideWindowsTool: async () => ({ tool: 'appkit', reason: '' }) } });
  assert.deepEqual(await mac.nag.capabilities(), { popup: 'main', allScreens: false, minimize: { ok: true, reason: '' } });
  const throws = rig({ collectors: { hideWindowsTool: async () => { throw new Error('x'); } } });
  assert.deepEqual((await throws.nag.capabilities()).minimize, { ok: false, reason: 'unavailable' });
});

test('the text is one clean line of at most 200 characters, and the font falls back to Consolas', () => {
  assert.equal(cleanText('a\u0000b\nc\u007f'), 'a b c');
  assert.equal(cleanText('x'.repeat(300)).length, 200);
  assert.equal(popupFont('ja-JP'), 'Yu Gothic UI');
  assert.equal(popupFont('zh_CN'), 'Microsoft YaHei');
  assert.equal(popupFont('it'), 'Consolas');
});

test('Linux: show desktop on X11, kglobalaccel on KDE Wayland, nothing on GNOME Wayland', () => {
  assert.deepEqual(lc.linuxSession({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' }), { wayland: false, kde: false });
  assert.deepEqual(lc.linuxSession({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }), { wayland: true, kde: true });
  assert.deepEqual(lc.linuxSession({ DESKTOP_SESSION: 'plasma' }), { wayland: false, kde: true });
  assert.equal(lc.pickHideTool({ wayland: false, kde: false }, { wmctrl: true }), 'wmctrl');
  assert.equal(lc.pickHideTool({ wayland: false, kde: true }, { wmctrl: false, dbusSend: true }), 'kwin');
  assert.equal(lc.pickHideTool({ wayland: true, kde: true }, { wmctrl: true, dbusSend: true }), 'kwin');
  assert.equal(lc.pickHideTool({ wayland: true, kde: false }, { wmctrl: true, dbusSend: true }), '');
  assert.equal(lc.pickHideTool({ wayland: false, kde: false }, { wmctrl: false }), '');
});

test('macOS: the hide script answers how many apps it found and hid, anything else is no answer', () => {
  assert.deepEqual(dc.parseHideResult('{"shown":3,"hidden":3}\n'), { shown: 3, hidden: 3 });
  assert.equal(dc.parseHideResult('execution error'), null);
  assert.equal(dc.parseHideResult('{"shown":"3","hidden":1}'), null);
  assert.equal(dc.parseHideResult(''), null);
});

test('every collector set offers the same three calls', () => {
  for (const c of [lc, dc]) {
    for (const name of ['hideWindows', 'hideWindowsTool', 'notify']) assert.equal(typeof c[name], 'function', name);
  }
});

test('Settings copy: every language explains what this PC cannot do, and none says "Windows"', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8') + ';globalThis.__i18n = i18n;', ctx);
  const KEYS = ['settings_vpet_cap_main', 'settings_vpet_cap_notify', 'settings_vpet_cap_none', 'settings_vpet_cap_wayland', 'settings_vpet_cap_wmctrl'];
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    const d = ctx.__i18n[lang];
    for (const k of KEYS) assert.ok(d[k], lang + ' ' + k);
    for (const k of ['settings_vpet_monitors_hint', 'settings_vpet_minimize_hint', 'settings_vpet_lock_hint']) {
      assert.doesNotMatch(d[k], /Windows/, lang + ' ' + k);
    }
  }
});

test('AI roasts: on Sparks, Claude Code or Codex Settings says Bit keeps to its own lines, in every language', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const src = read('../js/settings.js');
  const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)) + to.length);
  const el = { textContent: '', hidden: true };
  const ctx = { hubSettings: {}, $: (id) => (id === 'settings-vpet-ai-cap' ? el : null), t: (k) => k };
  vm.createContext(ctx);
  vm.runInContext(cut('function vitalsCapLine(', '\n}\n') + cut('const VITALS_AI_BANK_PROVIDERS', '\n}\n') + 'globalThis.sync = syncVitalsAiBank;', ctx);
  for (const [provider, shown] of [['xenon', true], ['claudecode', true], ['codex', true], ['gemini', false], ['ollama', false], [undefined, false]]) {
    ctx.hubSettings = { aiProvider: provider };
    ctx.sync();
    assert.equal(el.hidden, !shown, String(provider));
    assert.equal(el.textContent, shown ? 'settings_vpet_ai_bank' : '', String(provider));
  }
  assert.match(src, /syncVitalsPcCaps\(\);\n\s*syncVitalsAiBank\(\);/);
  assert.match(read('../index.html'), /id="settings-vpet-ai-cap" hidden/);
  assert.deepEqual(require('../ai-cli.js').isCliProvider('claudecode') && require('../ai-cli.js').isCliProvider('codex'), true, 'the server roast skips the same providers');
  const i18n = { window: {} };
  vm.createContext(i18n);
  vm.runInContext(read('../js/i18n.js') + ';globalThis.__i18n = i18n;', i18n);
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) assert.ok(i18n.__i18n[lang].settings_vpet_ai_bank, lang);
});
