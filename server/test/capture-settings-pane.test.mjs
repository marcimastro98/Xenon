// js/capture-settings-pane.js: Settings → Capture, and the benchmark folder in
// Settings → Performance. Pinned here: the values shown are the server's; each folder row (videos, screenshots, benchmarks)
// shows its own folder, or the standard one with no "Back to…"; the space line
// says nothing before the first recording and explains the limit only when one
// is set; a paired phone sees the note, never the controls or the folders; a
// refused save says so and shows the truth again; "Change" and "Back to…" name
// the row they belong to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(DIR, 'js', 'capture-settings-pane.js'), 'utf8');
const HTML = readFileSync(path.join(DIR, 'index.html'), 'utf8');
const TUNING = ['fps', 'height', 'quality'];
const IDS = ['settings-capture-video-group', 'settings-nav-capture', 'settings-capture-remote', 'settings-capture-grid', 'settings-capture-shots', 'settings-bench-group', 'settings-bug-group', 'settings-capture-fps',
  'settings-capture-height', 'settings-capture-quality', 'settings-capture-maxgb', 'settings-capture-badge', 'settings-capture-limit-hint',
  'settings-replay-group', 'settings-replay-grid', 'settings-replay-on', 'settings-replay-state', 'settings-replay-disk', 'settings-replay-seconds',
  'settings-replay-custom', 'settings-replay-minutes', 'settings-replay-when', 'settings-replay-audio', 'settings-capture-why'];
const KINDS = ['recording', 'screenshot', 'benchmark'];
const ROWS = [...KINDS, 'bugreport', 'buglogs'];

const el = (id) => ({
  id, hidden: false, value: '', checked: false, textContent: '', disabled: false, synced: 0, classes: new Set(),
  _csSync() { this.synced++; },
  focus() { this.focused = true; },
  get classList() { const c = this.classes; return { toggle: (n, on) => (on ? c.add(n) : c.delete(n)) }; },
});

function folderRow(kind) {
  const parts = { path: el(`${kind}-path`), pick: el(`${kind}-pick`), reset: el(`${kind}-reset`) };
  const map = { '[data-folder-path]': parts.path, '[data-folder-pick]': parts.pick, '[data-folder-reset]': parts.reset };
  return { ...parts, querySelector: (sel) => map[sel] || null };
}

function load({ remote = false, server = {}, caps = { capture: true, benchmark: true }, platform } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, el(id)]));
  const rows = Object.fromEntries(ROWS.map((k) => [k, folderRow(k)]));
  const tuning = TUNING.map((k) => el(`tuning-${k}`));
  const badge = [el('tuning-badge')];
  const calls = [];
  const status = [];
  const state = {
    ok: true, fps: 60, height: 0, quality: 'normal', badge: true, maxGB: 0, folder: '', shotFolder: '', benchFolder: '',
    defaultFolder: 'C:\\V\\Xenon', defaultShotFolder: 'C:\\P\\Xenon', defaultBenchFolder: 'C:\\D\\Xenon\\Benchmark', defaultBugFolder: 'C:\\D\\Xenon\\Bug reports', usedBytes: 0, ...server,
  };
  const sandbox = {
    window: {
      __xenonRemote: remote,
      listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      CaptureToast: { clock: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` },
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => ({ '[data-capture-tuning]': tuning, '[data-capture-badge]': badge })[sel] || [],
      querySelector: (sel) => {
        const m = /data-folder-for="(\w+)"/.exec(sel);
        return (m && rows[m[1]]) || null;
      },
    },
    t: (_k, fallback) => fallback,
    formatBytes: (n) => `${(n / 1024 ** 3).toFixed(1)} GB`,
    setSettingsStatus: (k, kind) => status.push([k, kind]),
    setSettingsCardAvailable: (card, ok) => { if (card) { card.available = ok; card.hidden = !ok; } },
    apiJson: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
      if (url === '/capture/settings' && !opts) return state;
      if (url === '/capture/settings') return sandbox.refuse ? null : { ok: true, ...state, ...JSON.parse(opts.body) };
      if (url === '/capture/settings/pick') return sandbox.pickReply || { ok: true, cancelled: true };
      if (url === '/actions/catalog') return { capabilities: caps, platform };
      return null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { P: sandbox.window.CaptureSettingsPane, els, rows, tuning, badge, calls, status, sandbox };
}

test('the server values fill the controls; each standard folder shows with no reset', async () => {
  const { P, els, rows } = load({ server: { fps: 30, height: 720, quality: 'small', badge: false } });
  await P.show();
  assert.equal(els['settings-capture-fps'].value, '30');
  assert.equal(els['settings-capture-height'].value, '720');
  assert.equal(els['settings-capture-quality'].value, 'small');
  assert.ok(els['settings-capture-fps'].synced > 0, 'the custom select is told');
  assert.equal(els['settings-capture-badge'].checked, false);
  assert.deepEqual(KINDS.map((k) => rows[k].path.textContent), ['C:\\V\\Xenon', 'C:\\P\\Xenon', 'C:\\D\\Xenon\\Benchmark']);
  assert.deepEqual(KINDS.map((k) => rows[k].reset.hidden), [true, true, true]);
});

test('a chosen folder shows in its own row only, with its "Back to…"', async () => {
  const { P, rows } = load({ server: { shotFolder: 'E:\\Shots' } });
  await P.show();
  assert.deepEqual(KINDS.map((k) => rows[k].path.textContent), ['C:\\V\\Xenon', 'E:\\Shots', 'C:\\D\\Xenon\\Benchmark']);
  assert.deepEqual(KINDS.map((k) => rows[k].reset.hidden), [true, false, true]);
});

test('the space line: nothing before the first recording, the size after, the rule with a limit', () => {
  const { P, els, rows } = load();
  const hint = els['settings-capture-limit-hint'];
  P.render({ maxGB: 0, usedBytes: 0 });
  assert.equal(hint.hidden, true);
  assert.equal(hint.textContent, '');
  P.render({ maxGB: 0, usedBytes: 2 * 1024 ** 3 });
  assert.equal(hint.textContent, 'Le registrazioni ora occupano 2.0 GB.');
  assert.equal(hint.hidden, false);
  P.render({ maxGB: 25, usedBytes: 0 });
  assert.equal(hint.textContent, 'Oltre il limite, dopo ogni registrazione Xenon cancella le più vecchie.');
  P.render({ maxGB: 25, usedBytes: 2 * 1024 ** 3, folder: 'D:\\Clips' });
  assert.match(hint.textContent, /^Le registrazioni ora occupano 2\.0 GB\. Oltre il limite/);
  assert.equal(rows.recording.path.textContent, 'D:\\Clips');
  assert.equal(rows.recording.reset.hidden, false);
});

test('a paired phone gets the note only and asks the server nothing', async () => {
  const { P, els, calls } = load({ remote: true });
  await P.show();
  assert.equal(els['settings-capture-remote'].hidden, false);
  assert.equal(els['settings-capture-grid'].hidden, true);
  assert.equal(els['settings-capture-shots'].available, false, 'no screenshot folder on the phone');
  assert.equal(els['settings-bench-group'].available, false, 'no benchmark folder on the phone');
  assert.equal(els['settings-bug-group'].available, false, 'no bug report folders on the phone');
  assert.deepEqual(calls, []);
});

test('a change posts only that key with the right type; a refusal says so and reloads', async () => {
  const { P, calls, status, sandbox } = load();
  await P.show();
  await P.set('fps', '30');
  await P.set('badge', false);
  await P.set('quality', 'high');
  assert.deepEqual(calls.filter((c) => c.body).map((c) => c.body), [{ fps: 30 }, { badge: false }, { quality: 'high' }]);
  assert.deepEqual(status.at(-1), ['settings_saved', 'ok']);
  sandbox.refuse = true;
  const before = calls.length;
  await P.set('fps', '60');
  assert.deepEqual(status.at(-1), ['settings_capture_failed', 'error']);
  assert.equal(calls.at(-1).url, '/capture/settings', 'the truth is read again');
  assert.ok(calls.length === before + 2);
});

test('"Back to…" sends that row\'s empty folder; the nav shows only where capture runs', async () => {
  const { P, calls, els } = load();
  await P.resetFolder();
  await P.resetFolder('screenshot');
  await P.resetFolder('benchmark');
  assert.deepEqual(calls.filter((c) => c.body).map((c) => c.body), [{ folder: '' }, { shotFolder: '' }, { benchFolder: '' }]);
  els['settings-nav-capture'].hidden = true;
  P.probe();
  await new Promise((r) => setImmediate(r));
  assert.equal(els['settings-nav-capture'].hidden, false);
  assert.equal(els['settings-bench-group'].available, true);
});

test('the benchmark folder shows only where a benchmark runs and the folder dialog exists', async () => {
  for (const [caps, want] of [[{ capture: true, benchmark: false }, false], [{ capture: false, benchmark: true }, false], [{ capture: true, benchmark: true }, true]]) {
    const { P, els } = load({ caps });
    P.probe();
    await new Promise((r) => setImmediate(r));
    assert.equal(els['settings-bench-group'].available, want, JSON.stringify(caps));
  }
  const phone = load({ remote: true });
  phone.P.probe();
  await new Promise((r) => setImmediate(r));
  assert.equal(phone.els['settings-bench-group'].available, false, 'never on a paired device');
});

test('"Change" asks for its own folder, waits with that button only, and names a busy dialog', async () => {
  const { P, calls, rows, status, sandbox } = load();
  let during = null;
  const ask = sandbox.apiJson;
  sandbox.apiJson = async (url, opts) => {
    if (url === '/capture/settings/pick') during = KINDS.map((k) => rows[k].pick.disabled);
    return ask(url, opts);
  };
  await P.pick('benchmark');
  assert.deepEqual(calls.find((c) => c.url === '/capture/settings/pick').body, { for: 'benchmark' });
  assert.deepEqual(during, [false, false, true]);
  assert.equal(rows.benchmark.pick.disabled, false);
  assert.equal(rows.benchmark.pick.textContent, 'Cambia');
  sandbox.pickReply = { ok: false, error: 'picking' };
  await P.pick('screenshot');
  assert.deepEqual(status.at(-1), ['settings_folder_busy', 'error']);
});

test('the markup has one row per folder, each wired to its kind', () => {
  for (const kind of KINDS) {
    const row = HTML.slice(HTML.indexOf(`data-folder-for="${kind}"`), HTML.indexOf(`data-folder-for="${kind}"`) + 1200);
    assert.ok(row.includes(`CaptureSettingsPane.pick('${kind}')`), kind);
    assert.ok(row.includes(`CaptureSettingsPane.resetFolder('${kind}')`), kind);
  }
  assert.ok(!HTML.includes('settings-capture-pick'), 'the old single folder row is gone');
  assert.ok(!HTML.includes('settings-capture-folders'), 'no shared "Where to save" group');
  // Each folder lives with what it saves: screenshots in their own group, videos
  // inside the recording options, benchmarks under Performance.
  const groupOf = (kind) => {
    const at = HTML.indexOf(`data-folder-for="${kind}"`);
    const open = HTML.lastIndexOf('<div class="settings-group"', at);
    return HTML.slice(open, HTML.indexOf('>', open));
  };
  assert.match(groupOf('screenshot'), /data-settings-cat="capture" id="settings-capture-shots"/);
  assert.match(groupOf('recording'), /data-settings-cat="capture"/);
  assert.ok(HTML.indexOf('data-folder-for="recording"') > HTML.indexOf('id="settings-capture-grid"'), 'video folder inside the recording grid');
  assert.match(groupOf('benchmark'), /data-settings-cat="performance" id="settings-bench-group" data-unavailable="1" hidden/);
  // Each folder group is a top-level card, never nested in the one before it:
  // between the previous group's start and this one every <div> is closed.
  for (const id of ['settings-capture-shots', 'settings-bench-group']) {
    const at = HTML.indexOf(`id="${id}"`);
    const open = HTML.lastIndexOf('<div class="settings-group"', at);
    const prev = Math.max(HTML.lastIndexOf('<div class="settings-group"', open - 1), HTML.lastIndexOf('<div class="settings-group ', open - 1));
    const between = HTML.slice(prev, open);
    assert.equal((between.match(/<div[\s>]/g) || []).length, (between.match(/<\/div>/g) || []).length, `${id} is not nested`);
  }
});

// ── Instant Replay ────────────────────────────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the replay rows show the server: switch, length, when, audio, and the disk it takes', async () => {
  const { P, els } = load({ server: {
    replay: true, replaySeconds: 300, replayWhen: 'always', replayAudio: 'silent',
    replayState: { enabled: true, on: true, kept: 300 }, replayBytesPerSecond: 2e6, replayFreeBytes: 500e9,
  } });
  await P.show();
  assert.equal(els['settings-replay-on'].checked, true);
  assert.equal(els['settings-replay-seconds'].value, '300');
  assert.equal(els['settings-replay-custom'].hidden, true);
  assert.equal(els['settings-replay-when'].value, 'always');
  assert.equal(els['settings-replay-audio'].value, 'silent');
  assert.equal(els['settings-replay-state'].textContent, 'On: keeping the last 5:00');
  // 302 s at 2 MB/s.
  assert.equal(els['settings-replay-disk'].textContent, 'About 0.6 GB on the disk while it is on');
  assert.equal(els['settings-replay-disk'].classes.has('settings-note-warn'), false);
});

test('a length set by voice that is not in the list shows as Other, in minutes', async () => {
  const { P, els } = load({ server: { replaySeconds: 97 } });
  await P.show();
  assert.equal(els['settings-replay-seconds'].value, 'custom');
  assert.equal(els['settings-replay-custom'].hidden, false);
  assert.equal(els['settings-replay-minutes'].value, '1.62');
});

test('Other opens the minutes field and saves nothing; minutes save as whole seconds', async () => {
  const { P, els, calls, status } = load();
  await P.show();
  P.setReplayLength('custom');
  assert.equal(els['settings-replay-custom'].hidden, false);
  assert.equal(els['settings-replay-minutes'].focused, true);
  assert.ok(!calls.some((c) => c.body && 'replaySeconds' in c.body));
  P.setReplayMinutes('2,5');
  await flush();
  assert.deepEqual(calls.find((c) => c.body && 'replaySeconds' in c.body).body, { replaySeconds: 150 });
  P.setReplayMinutes('0.1');
  P.setReplayMinutes('61');
  assert.deepEqual(status.filter((s) => s[0] === 'settings_replay_bad_length'), [['settings_replay_bad_length', 'error'], ['settings_replay_bad_length', 'error']]);
  P.setReplayLength('600');
  await flush();
  assert.deepEqual(calls.filter((c) => c.body && 'replaySeconds' in c.body).map((c) => c.body.replaySeconds), [150, 600]);
});

test('the switch and the choices post the right types', async () => {
  const { P, calls } = load();
  await P.set('replay', true);
  await P.set('replayWhen', 'always');
  await P.set('replayAudio', 'sound_mic');
  const bodies = calls.filter((c) => c.url === '/capture/settings' && c.body).map((c) => c.body);
  assert.deepEqual(bodies, [{ replay: true }, { replayWhen: 'always' }, { replayAudio: 'sound_mic' }]);
});

test('the disk line warns when the length does not fit; no estimate, no line', async () => {
  const short = load({ server: { replaySeconds: 3600, replayBytesPerSecond: 10e6, replayFreeBytes: 20e9 } });
  await short.P.show();
  assert.match(short.els['settings-replay-disk'].textContent, /^Needs 33.5 GB, the disk has 18\.6 GB free$/);
  assert.equal(short.els['settings-replay-disk'].classes.has('settings-note-warn'), true);
  const none = load();
  await none.P.show();
  assert.equal(none.els['settings-replay-disk'].hidden, true);
});

test('the state line: waiting for a game, a failure with its reason, nothing when off', () => {
  const { P } = load();
  const on = { replay: true, replaySeconds: 30 };
  assert.equal(P.replayStateText({ waiting: true }, on), 'Starts by itself when a game is in front');
  assert.equal(P.replayStateText({ error: 'no_encoder' }, on), 'Instant Replay could not start. This PC has no video encoder');
  assert.equal(P.replayStateText({ error: 'engine_exited' }, on), 'Instant Replay could not start. Xenon tries again by itself');
  assert.equal(P.replayStateText({ on: true, kept: 30 }, { replay: false }), '');
});

test('the live SSE state updates the line; a switch flipped elsewhere reloads the pane', async () => {
  const { P, els, calls, sandbox } = load({ server: { replay: true, replayState: { enabled: true, waiting: true } } });
  await P.show();
  assert.equal(els['settings-replay-state'].textContent, 'Starts by itself when a game is in front');
  sandbox.window.listeners['xenon:replay']({ detail: { enabled: true, on: true, kept: 30 } });
  assert.equal(els['settings-replay-state'].textContent, 'On: keeping the last 0:30');
  const gets = calls.filter((c) => c.url === '/capture/settings' && !c.body).length;
  sandbox.window.listeners['xenon:replay']({ detail: { enabled: false, on: false } });
  await flush();
  assert.equal(calls.filter((c) => c.url === '/capture/settings' && !c.body).length, gets + 1);
});

test('a paired phone sees no replay controls', async () => {
  const { P, els } = load({ remote: true });
  await P.show();
  assert.equal(els['settings-replay-grid'].hidden, true);
  assert.equal(els['settings-replay-group'].available, false);
});

test('the markup has every replay row, the presets from 15 s to 60 min and Other', () => {
  for (const id of ['settings-replay-on', 'settings-replay-seconds', 'settings-replay-minutes', 'settings-replay-when', 'settings-replay-audio', 'settings-replay-disk', 'settings-replay-state']) {
    assert.ok(HTML.includes(`id="${id}"`), id);
  }
  const sel = HTML.slice(HTML.indexOf('id="settings-replay-seconds"'), HTML.indexOf('</select>', HTML.indexOf('id="settings-replay-seconds"')));
  assert.deepEqual([...sel.matchAll(/value="(\w+)"/g)].map((m) => m[1]), ['15', '30', '60', '120', '300', '600', '1200', '3600', 'custom']);
});

test('bug report: its folder shows Documents until changed; the log folder reads "No folder" with no "Remove"', async () => {
  const { P, rows, calls } = load();
  await P.show();
  assert.equal(rows.bugreport.path.textContent, 'C:\\D\\Xenon\\Bug reports');
  assert.equal(rows.bugreport.reset.hidden, true);
  assert.equal(rows.buglogs.path.textContent, 'No folder');
  assert.equal(rows.buglogs.reset.hidden, true);
  P.render({ bugLogs: 'E:\\Logs', bugFolder: 'E:\\Reports' });
  assert.deepEqual([rows.buglogs.path.textContent, rows.buglogs.reset.hidden], ['E:\\Logs', false]);
  assert.deepEqual([rows.bugreport.path.textContent, rows.bugreport.reset.hidden], ['E:\\Reports', false]);
  await P.resetFolder('buglogs');
  await P.pick('bugreport');
  assert.deepEqual(calls.filter((c) => c.body).map((c) => c.body), [{ bugLogs: '' }, { for: 'bugreport' }]);
  for (const kind of ['bugreport', 'buglogs']) {
    const at = HTML.indexOf(`data-folder-for="${kind}"`);
    const open = HTML.lastIndexOf('<div class="settings-group"', at);
    assert.match(HTML.slice(open, HTML.indexOf('>', open)), /data-settings-cat="capture" id="settings-bug-group"/, kind);
  }
});

// An engine that cannot record, keep a replay or tune the recording has those
// rows hidden, not offered and then refused. The timer pill is its own probe:
// a Linux engine tunes the video but draws no pill.
test('what this engine cannot do is hidden: video, replay, the tuning rows', async () => {
  const mac = load({ caps: { capture: true, benchmark: false, captureVideo: true, captureReplay: false, captureTuning: false } });
  mac.P.probe();
  await new Promise((r) => setImmediate(r));
  assert.equal(mac.els['settings-capture-video-group'].available, true);
  assert.equal(mac.els['settings-replay-group'].available, false);
  assert.ok(mac.tuning.every((row) => row.hidden === true));
  await mac.P.show();
  assert.equal(mac.els['settings-replay-group'].available, false, 'a reload of the pane keeps it hidden');
  const win = load({ caps: { capture: true, benchmark: true, captureVideo: true, captureReplay: true, captureTuning: true } });
  win.P.probe();
  await new Promise((r) => setImmediate(r));
  assert.equal(win.els['settings-replay-group'].available, true);
  assert.ok(win.tuning.every((row) => row.hidden === false));
  assert.equal(win.badge[0].hidden, false, 'a catalog without captureBadge keeps the pill row');
  const linux = load({ caps: { capture: true, captureVideo: true, captureTuning: true, captureBadge: false } });
  linux.P.probe();
  await new Promise((r) => setImmediate(r));
  assert.ok(linux.tuning.every((row) => row.hidden === false));
  assert.equal(linux.badge[0].hidden, true);
  const none = load({ caps: { capture: true, benchmark: false, captureVideo: false, captureReplay: false, captureTuning: false } });
  none.P.probe();
  await new Promise((r) => setImmediate(r));
  assert.equal(none.els['settings-capture-video-group'].available, false);
});

test('index.html marks the video group, its three tuning rows and the pill row', () => {
  assert.match(HTML, /data-settings-cat="capture" id="settings-capture-video-group"/);
  assert.equal((HTML.match(/data-capture-tuning/g) || []).length, 3);
  assert.match(HTML, /data-capture-badge>\s*<input class="settings-check" id="settings-capture-badge"/);
});

test('what is missing on this OS says why, in one line; nothing missing, no line', async () => {
  const cases = [
    ['linux', { capture: true, captureVideo: false, captureReplay: false }, /needs ffmpeg on X11.*GStreamer PipeWire plugin on GNOME and KDE/],
    ['linux', { capture: true, captureVideo: true, captureReplay: false }, /^Instant Replay needs ffmpeg\. It is not available on GNOME and KDE with Wayland\.$/],
    ['darwin', { capture: true, captureVideo: true, captureReplay: false }, /not on the Mac yet/],
  ];
  for (const [platform, caps, want] of cases) {
    const p = load({ caps, platform });
    p.P.probe();
    await new Promise((r) => setImmediate(r));
    assert.equal(p.els['settings-capture-why'].hidden, false, platform);
    assert.match(p.els['settings-capture-why'].textContent, want);
  }
  for (const [platform, caps] of [
    ['win32', { capture: true, captureVideo: true, captureReplay: true }],
    ['linux', { capture: true, captureVideo: true, captureReplay: true }],
    ['win32', { capture: true, captureReplay: false }],
    [undefined, { capture: true, captureReplay: false }],
  ]) {
    const p = load({ caps, platform });
    p.P.probe();
    await new Promise((r) => setImmediate(r));
    assert.equal(p.els['settings-capture-why'].hidden, true, String(platform));
    assert.equal(p.els['settings-capture-why'].textContent, '');
  }
  const { P } = load();
  assert.equal(P.missingWhy({ capture: false, captureVideo: false }, 'linux'), null, 'no engine: the page is not shown at all');
  assert.match(HTML, /class="settings-row full settings-note" id="settings-capture-why" hidden/);
});
