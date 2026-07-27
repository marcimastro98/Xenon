// The Linux foreground probe. The parsers are pure, so the interesting cases —
// Xwayland's focus proxy, a window with no properties, Hyprland's fullscreen
// field changing type between versions — are all reachable without a compositor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  createLinuxForeground, parseActiveWindowId, parseClientList,
  parseWindowInfo, parseHyprctl, parseSwayTree,
} = require(join(ROOT, 'linux-foreground.js'));

test('the active window id is read, and a zero id means nothing is focused', () => {
  assert.equal(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0xE00003'), '0xe00003');
  // The EWMH spec allows 0 for "no window has focus". Returning "0x0" would send
  // the caller off to xprop an id that cannot exist.
  assert.equal(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0'), null);
  assert.equal(parseActiveWindowId('_NET_ACTIVE_WINDOW:  not found.'), null);
  assert.equal(parseActiveWindowId(''), null);
  // xprop drops the "window id #" wording when it does not know the property's
  // format, which happens on a root property another tool has rewritten.
  assert.equal(parseActiveWindowId('_NET_ACTIVE_WINDOW(ATOM) = 0xE00003'), '0xe00003');
});

test('the client list is parsed as a set of ids, case-normalised', () => {
  const raw = '_NET_CLIENT_LIST(WINDOW): window id # 0xE00003, 0x1400007, 0x2A00005';
  assert.deepEqual(parseClientList(raw), ['0xe00003', '0x1400007', '0x2a00005']);
  assert.deepEqual(parseClientList('_NET_CLIENT_LIST:  not found.'), []);
});

test('a real client window yields instance, pid and fullscreen', () => {
  const raw = [
    'WM_CLASS(STRING) = "xenon-native", "Xenon-native"',
    '_NET_WM_PID(CARDINAL) = 204137',
    '_NET_WM_STATE(ATOM) = _NET_WM_STATE_FULLSCREEN',
  ].join('\n');
  // The INSTANCE ("xenon-native") is taken, not the Class ("Xenon-native"):
  // gamedetect's ignore list is written against binary names, and the Class is
  // a display name that would not match it.
  assert.deepEqual(parseWindowInfo(raw), { process: 'xenon-native', pid: 204137, fullscreen: true });
});

test("Xwayland's focus proxy parses to nothing, not to a stale window", () => {
  // This is the reading that matters most under a Wayland session: when a
  // native Wayland window has focus, _NET_ACTIVE_WINDOW points at a proxy that
  // owns none of these properties. Anything other than null here would pin game
  // mode to whichever X11 window was seen last — including after the game quit.
  const raw = [
    'WM_CLASS:  not found.',
    '_NET_WM_PID:  not found.',
    '_NET_WM_STATE:  not found.',
  ].join('\n');
  assert.equal(parseWindowInfo(raw), null);
});

test('a windowed client reports fullscreen false, not absent', () => {
  const raw = [
    'WM_CLASS(STRING) = "firefox", "firefox"',
    '_NET_WM_PID(CARDINAL) = 900',
    '_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_MAXIMIZED_VERT',
  ].join('\n');
  // Maximised is not fullscreen: a maximised window keeps its title bar and is
  // the normal state of every desktop app.
  assert.deepEqual(parseWindowInfo(raw), { process: 'firefox', pid: 900, fullscreen: false });
});

test("Hyprland's fullscreen field reads correctly whether it is a bool or an enum", () => {
  // Older Hyprland reported a boolean; current versions report 0 none /
  // 1 maximized / 2 fullscreen. Getting this wrong in either direction gives a
  // probe that reports "windowed" forever on half the installed base.
  const base = { class: 'cs2', pid: 4242 };
  assert.equal(parseHyprctl(JSON.stringify({ ...base, fullscreen: true })).fullscreen, true);
  assert.equal(parseHyprctl(JSON.stringify({ ...base, fullscreen: false })).fullscreen, false);
  assert.equal(parseHyprctl(JSON.stringify({ ...base, fullscreen: 2 })).fullscreen, true);
  assert.equal(parseHyprctl(JSON.stringify({ ...base, fullscreen: 1 })).fullscreen, false);
  assert.equal(parseHyprctl(JSON.stringify({ ...base, fullscreen: 0 })).fullscreen, false);
  assert.deepEqual(parseHyprctl(JSON.stringify({ ...base, fullscreen: 2 })),
    { process: 'cs2', pid: 4242, fullscreen: true });
});

test('an empty Hyprland reply (nothing focused) is null, not a blank window', () => {
  assert.equal(parseHyprctl('{}'), null);
  assert.equal(parseHyprctl('not json'), null);
});

test('the sway tree is walked to the focused leaf', () => {
  const tree = {
    type: 'root', focused: false,
    nodes: [{
      type: 'output', focused: false,
      nodes: [{
        type: 'workspace', focused: false, // a focused workspace is not a window
        nodes: [
          { type: 'con', focused: false, app_id: 'firefox', pid: 1 },
          { type: 'con', focused: true, app_id: 'ftl', pid: 77, fullscreen_mode: 1 },
        ],
        floating_nodes: [],
      }],
    }],
  };
  assert.deepEqual(parseSwayTree(JSON.stringify(tree)), { process: 'ftl', pid: 77, fullscreen: true });
});

test('a focused Xwayland window under sway is named by its X11 instance', () => {
  const tree = {
    type: 'root',
    nodes: [{
      type: 'con', focused: true, pid: 5,
      window_properties: { instance: 'steam_app_570', class: 'dota2' },
    }],
  };
  assert.equal(parseSwayTree(JSON.stringify(tree)).process, 'steam_app_570');
});

test('a focused workspace with no window in it reports nothing', () => {
  const tree = { type: 'root', nodes: [{ type: 'workspace', focused: true, nodes: [], floating_nodes: [] }] };
  assert.equal(parseSwayTree(JSON.stringify(tree)), null);
});

test('samples reach the callback in the shape gamedetect consumes', async () => {
  const seen = [];
  const probe = createLinuxForeground({
    intervalMs: 10,
    backend: async () => ({ process: 'Portal2', pid: '31337', fullscreen: true }),
    onSample: (s) => seen.push(s),
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 40));
  probe.stop();
  assert.ok(seen.length >= 1);
  // pid must be a number and fullscreen a real boolean: gamedetect does
  // `process.kill(pid, 0)` on it and compares `fullscreen === true`.
  assert.deepEqual(seen[0], { fullscreen: true, process: 'Portal2', pid: 31337 });
});

test('a backend that throws does not stop the probe or emit a sample', async () => {
  const seen = [];
  let calls = 0;
  const probe = createLinuxForeground({
    intervalMs: 10,
    backend: async () => { calls++; throw new Error('no X server'); },
    onSample: (s) => seen.push(s),
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 45));
  probe.stop();
  assert.equal(seen.length, 0);
  assert.ok(calls >= 2, 'the probe keeps trying after a failure');
});

test('stop() is final: a sample already in flight is dropped', async () => {
  const seen = [];
  let release;
  const probe = createLinuxForeground({
    intervalMs: 10,
    backend: () => new Promise((r) => { release = () => r({ process: 'late', pid: 1, fullscreen: true }); }),
    onSample: (s) => seen.push(s),
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 15));
  probe.stop();
  release();
  await new Promise((r) => setTimeout(r, 20));
  // Delivering this would resurrect a window the caller was told to forget.
  assert.equal(seen.length, 0);
});
