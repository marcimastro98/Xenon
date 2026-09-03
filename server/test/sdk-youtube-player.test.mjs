// The host's YouTube player, lent to a community widget.
//
// A widget's frame has an opaque origin and a CSP that blocks all network, which
// is exactly what makes installing one safe — and exactly why a widget cannot
// embed YouTube itself. Asked for by the author of a YouTube widget who had built
// a private host bridge to get a player inside his own layout.
//
// So Xenon owns the player and places it over the widget's frame at a rectangle
// the widget names. Everything the widget sends is a value to be checked, and the
// rules below are the ones that keep a borrowed player from becoming something
// else: an invisible speaker, a second video talking over the first, or a video
// still playing for a widget that is no longer on the dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SRC = readFileSync(new URL('../js/sdk-youtube-player.js', import.meta.url), 'utf8');
const BRIDGE = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');

// A DOM small enough to read: a box with a size, and iframes that remember what
// was set on them. The module only ever touches this much of one.
function boot({ w = 400, h = 300 } = {}) {
  const listeners = [];
  const win = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  const frames = [];
  const doc = {
    createElement: () => {
      const f = {
        style: {}, tagName: 'IFRAME', isConnected: false, parentNode: null,
        contentWindow: { posted: [], postMessage(m) { this.posted.push(JSON.parse(m)); } },
        addEventListener: (t, fn) => { if (t === 'load') f._onload = fn; },
      };
      frames.push(f);
      return f;
    },
  };
  const box = {
    clientWidth: w, clientHeight: h, isConnected: true, children: [],
    appendChild(n) { this.children.push(n); n.isConnected = true; n.parentNode = this; },
    removeChild(n) { this.children = this.children.filter((c) => c !== n); n.isConnected = false; n.parentNode = null; },
  };
  const timers = new Set();
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', 'setInterval', 'clearInterval', SRC)(
    win, doc, { origin: 'http://127.0.0.1:3030' },
    (fn) => { const id = { fn }; timers.add(id); return id; },
    (id) => { timers.delete(id); },
  );
  const player = win.SdkYouTubePlayer;
  // Speak as the embed does: only a message from the embed origin, carried by the
  // player's own frame, is listened to at all.
  const fromEmbed = (data, opts = {}) => {
    const f = frames[frames.length - 1];
    for (const fn of listeners) {
      fn({ origin: opts.origin || 'https://www.youtube-nocookie.com', source: opts.source || (f && f.contentWindow), data: JSON.stringify(data) });
    }
  };
  return { player, box, frames, fromEmbed, last: () => frames[frames.length - 1] };
}

const RECT = { video: 'dQw4w9WgXcQ', x: 10, y: 20, w: 200, h: 120 };
const events = () => { const got = []; return { got, on: (e) => got.push(e) }; };

// ── Where it goes ────────────────────────────────────────────────────────────

test('show puts a player over the widget at the rectangle it asked for', () => {
  const h = boot();
  const r = h.player.exec({}, h.box, 'show', RECT, () => {});
  assert.deepEqual(r, { ok: true });
  const f = h.last();
  assert.equal(h.box.children.length, 1, 'the player is a sibling of the guest frame, inside the tile');
  assert.deepEqual([f.style.left, f.style.top, f.style.width, f.style.height], ['10px', '20px', '200px', '120px']);
  assert.ok(f.src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'), f.src);
  assert.ok(!/allowfullscreen/i.test(String(f.allow || '')), 'fullscreen is withheld — it breaks the kiosk surface');
});

test('a rectangle reaching past the tile is trimmed, not refused', () => {
  const h = boot({ w: 400, h: 300 });
  h.player.exec({}, h.box, 'show', { video: 'dQw4w9WgXcQ', x: 380, y: 290, w: 900, h: 900 }, () => {});
  const f = h.last();
  assert.deepEqual([f.style.width, f.style.height], ['400px', '300px'], 'clamped to the tile');
  assert.deepEqual([f.style.left, f.style.top], ['0px', '0px'], 'and pulled back inside it');
});

test('a player too small to see is refused', () => {
  // Otherwise a widget has an invisible speaker: audio playing from a one-pixel
  // frame nobody can find, let alone stop.
  const h = boot();
  h.player.exec({}, h.box, 'show', { ...RECT, w: 4, h: 4 }, () => {});
  const f = h.last();
  assert.deepEqual([f.style.width, f.style.height], ['96px', '54px'], 'a floor, not a refusal, when the tile has room');
  const tiny = boot({ w: 40, h: 30 });
  assert.deepEqual(tiny.player.exec({}, tiny.box, 'show', RECT, () => {}), { ok: false, error: 'too_small' });
  assert.equal(tiny.box.children.length, 0);
});

test('rect moves the player without rebuilding it', () => {
  const h = boot();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, () => {});
  const first = h.last();
  h.player.exec(owner, h.box, 'rect', { x: 0, y: 0, w: 300, h: 200 }, () => {});
  assert.equal(h.frames.length, 1, 'moving a player must not reload the video');
  assert.deepEqual([first.style.left, first.style.width], ['0px', '300px']);
});

// ── What a widget may say ────────────────────────────────────────────────────

test('a video id is a video id — never a URL', () => {
  const h = boot();
  for (const video of ['', null, 'https://youtu.be/dQw4w9WgXcQ', '../../evil', 'dQw4w9WgXcQ?x=1', 'ab', 'x'.repeat(40)]) {
    const r = h.player.exec({}, h.box, 'show', { ...RECT, video }, () => {});
    assert.deepEqual(r, { ok: false, error: 'bad_video' }, String(video));
  }
  assert.equal(h.frames.length, 0, 'a refused id never becomes an embed URL');
});

test('seek takes seconds, and only seconds', () => {
  const h = boot();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, () => {});
  for (const seconds of ['soon', NaN, Infinity, -5, null, {}]) {
    assert.equal(h.player.exec(owner, h.box, 'seek', { seconds }, () => {}).error, 'bad_seconds', String(seconds));
  }
  assert.deepEqual(h.player.exec(owner, h.box, 'seek', { seconds: 90 }, () => {}), { ok: true });
  const sent = h.last().contentWindow.posted.filter((m) => m.func === 'seekTo');
  assert.deepEqual(sent[0].args, [90, true]);
});

test('an op nobody documented does nothing', () => {
  const h = boot();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, () => {});
  assert.equal(h.player.exec(owner, h.box, 'evaluate', {}, () => {}).error, 'bad_op');
});

test('commands need a player, and the player has to be yours', () => {
  const h = boot();
  const mine = {}; const theirs = {};
  assert.equal(h.player.exec(mine, h.box, 'play', {}, () => {}).error, 'no_player');
  h.player.exec(mine, h.box, 'show', RECT, () => {});
  assert.equal(h.player.exec(theirs, h.box, 'pause', {}, () => {}).error, 'no_player',
    'a second widget cannot drive the first one\'s player');
});

// ── One at a time ────────────────────────────────────────────────────────────

test('a second widget takes the player over, and the first is told', () => {
  const h = boot();
  const a = events();
  const first = {};
  h.player.exec(first, h.box, 'show', RECT, a.on);
  h.player.exec({}, h.box, 'show', { ...RECT, video: 'oHg5SJYRHA0' }, () => {});
  assert.equal(h.box.children.length, 1, 'two videos must never talk at once');
  assert.deepEqual(a.got.map((e) => [e.event, e.reason]), [['closed', 'replaced']]);
  assert.equal(h.player.owns(first), false);
});

test('load swaps the video in a player that is already answering', () => {
  const h = boot();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, () => {});
  h.fromEmbed({ event: 'infoDelivery', info: { currentTime: 3 } });   // it has answered
  h.player.exec(owner, h.box, 'load', { ...RECT, video: 'oHg5SJYRHA0' }, () => {});
  assert.equal(h.frames.length, 1, 'a live player swaps the video rather than booting a new embed');
  const sent = h.last().contentWindow.posted.filter((m) => m.func === 'loadVideoById');
  assert.deepEqual(sent[0].args, ['oHg5SJYRHA0']);
});

test('load with no player yet simply makes one', () => {
  const h = boot();
  assert.deepEqual(h.player.exec({}, h.box, 'load', RECT, () => {}), { ok: true });
  assert.equal(h.frames.length, 1);
});

// ── Going away ───────────────────────────────────────────────────────────────

test('hide takes the player away and says so', () => {
  const h = boot();
  const a = events();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, a.on);
  h.player.exec(owner, h.box, 'hide', {}, a.on);
  assert.equal(h.box.children.length, 0);
  assert.deepEqual(a.got.map((e) => [e.event, e.reason]), [['closed', 'hidden']]);
});

test('release is for the widget that went away; a stranger cannot close your player', () => {
  const h = boot();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, () => {});
  h.player.release({});
  assert.equal(h.player.owns(owner), true);
  h.player.release(owner);
  assert.equal(h.player.active(), false);
  assert.equal(h.box.children.length, 0);
});

test('a player whose tile was rebuilt under it is noticed, not driven', () => {
  // .cw-body is replaced whenever a widget remounts (package swapped, files
  // reloaded), which takes the player with it. Commands into a detached node go
  // nowhere and would look to the widget like a player that stopped answering.
  const h = boot();
  const a = events();
  const owner = {};
  h.player.exec(owner, h.box, 'show', RECT, a.on);
  h.box.removeChild(h.last());              // as replaceChildren would
  assert.equal(h.player.active(), false);
  assert.deepEqual(a.got.map((e) => [e.event, e.reason]), [['closed', 'gone']]);
});

// ── What comes back ──────────────────────────────────────────────────────────

test('state changes reach the widget by name, and ended is its own event', () => {
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  h.fromEmbed({ event: 'onStateChange', info: 1 });
  h.fromEmbed({ event: 'onStateChange', info: 2 });
  h.fromEmbed({ event: 'onStateChange', info: 0 });
  assert.deepEqual(a.got.map((e) => [e.event, e.state]),
    [['state', 'playing'], ['state', 'paused'], ['ended', 'ended']]);
  assert.equal(a.got[0].video, 'dQw4w9WgXcQ', 'every event says which video it is about');
});

test('the same state twice is one event', () => {
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  h.fromEmbed({ event: 'onStateChange', info: 1 });
  h.fromEmbed({ event: 'onStateChange', info: 1 });
  assert.equal(a.got.length, 1);
});

test('position is throttled, because infoDelivery is a firehose', () => {
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  for (let i = 0; i < 20; i++) h.fromEmbed({ event: 'infoDelivery', info: { currentTime: i, duration: 200 } });
  assert.ok(a.got.length <= 2, 'a progress bar needs about one a second, not twenty: ' + a.got.length);
  assert.equal(a.got[0].duration, 200);
});

test('a state change inside infoDelivery is never throttled', () => {
  // The built-in tile learned this the hard way: a video can play to the end
  // reporting thirty infoDelivery messages and zero onStateChange.
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  h.fromEmbed({ event: 'infoDelivery', info: { currentTime: 1, playerState: 1 } });
  h.fromEmbed({ event: 'infoDelivery', info: { currentTime: 2, playerState: 0 } });
  assert.deepEqual(a.got.map((e) => e.event), ['state', 'ended']);
});

test('an embed error reaches the widget with its code', () => {
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  h.fromEmbed({ event: 'onError', info: 150 });
  assert.deepEqual([a.got[0].event, a.got[0].code], ['error', 150]);
});

test('nothing but the embed, speaking through our own frame, is listened to', () => {
  const h = boot();
  const a = events();
  h.player.exec({}, h.box, 'show', RECT, a.on);
  h.fromEmbed({ event: 'onStateChange', info: 1 }, { origin: 'https://evil.example' });
  h.fromEmbed({ event: 'onStateChange', info: 1 }, { source: { posted: [] } });
  assert.deepEqual(a.got, []);
});

// ── The boundary in custom-widget.js ─────────────────────────────────────────

test('the player is its own permission, not folded into an existing one', () => {
  const cats = require('../sdk-widgets.js').SDK_ACTION_CATEGORIES;
  assert.deepEqual([...cats.youtubePlayer], ['ytPlayer']);
  assert.deepEqual([...cats.youtube], ['ytBroadcast'], 'controlling a broadcast is a different thing to agree to');
  assert.match(BRIDGE, /if \(!grant\.actions\.includes\('youtubePlayer'\)\) \{ reply\(\{ ok: false, error: 'not_allowed' \}\); return; \}/);
});

test('the gate names a permission the user can actually hold', () => {
  // The bug this pins: `grant.actions` holds CATEGORY names — that is what the
  // dialog offers and what settings.js keeps (SDK_WIDGET_ACTION_CATS) — while
  // `ytPlayer` is an action TYPE inside a category. Gating on the type compiled,
  // read plausibly, and could never be true: the feature was unreachable, and a
  // manifest asking for it would have had the word stripped on save.
  const at = BRIDGE.indexOf('function onBridgeYoutubePlayer(');
  const gate = /grant\.actions\.includes\('([^']+)'\)/.exec(BRIDGE.slice(at, BRIDGE.indexOf('\n  }', at)));
  assert.ok(gate, 'the player must still be gated on a grant');
  const cats = require('../sdk-widgets.js').SDK_ACTION_CATEGORIES;
  assert.ok(Object.hasOwn(cats, gate[1]),
    `the bridge gates on "${gate[1]}", which is not an action category — a grant can never contain it`);
  const settings = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  const kept = /const SDK_WIDGET_ACTION_CATS = Object\.freeze\(\[([^\]]+)\]\)/.exec(settings);
  assert.ok(kept && kept[1].includes("'" + gate[1] + "'"),
    'and settings.js must keep it, or it is filtered out of the saved grant');
  // The manifest tells authors the same word, or they declare something that is
  // thrown away and the widget mounts without the permission it asked for.
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('`"actions": ["' + gate[1] + '"]`'), 'the guide must name the same grant');
});

test('taking the permission away stops a video that is already playing', () => {
  // The bridge re-checks per command, so revoking blocks the NEXT one — but the
  // video already on screen would have kept playing until the tile moved. That
  // is the shape reconcileExpanded avoids for the expanded panel.
  const at = BRIDGE.indexOf('function reconcileSdkPlayer(');
  const body = BRIDGE.slice(at, BRIDGE.indexOf('\n  }', at));
  assert.match(body, /grantsFor\(entry\.pkgId\)\.actions\.includes\('youtubePlayer'\)/,
    'the sweep must re-read the grant, not only the frame');
  assert.match(body, /if \(!granted \|\|/);
});

test('a hidden tile and a headless frame get no player at all', () => {
  const at = BRIDGE.indexOf('function onBridgeYoutubePlayer(');
  assert.notEqual(at, -1);
  const body = BRIDGE.slice(at, BRIDGE.indexOf('\n  }', at));
  assert.match(body, /if \(entry\.service\) \{ reply\(\{ ok: false, error: 'unavailable' \}\); return; \}/,
    'a background service frame has no tile — and must not be able to play video');
  assert.match(body, /!entryOnScreen\(entry\)/,
    'a player behind the dashboard is a video nobody can reach');
});

test('a player never outlives the widget holding it', () => {
  assert.match(BRIDGE, /function reconcileSdkPlayer\(\)/);
  assert.match(BRIDGE, /reconcileExpanded\(\);\n    reconcileSdkPlayer\(\);/,
    'the same sweep that catches an orphaned expanded panel catches an orphaned player');
  assert.match(BRIDGE, /if \(!visible && window\.SdkYouTubePlayer\) window\.SdkYouTubePlayer\.release\(entry\);/);
});

test('the SDK guide documents the ops, the events and the rules', () => {
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  assert.match(doc, /### 3g\. A YouTube player inside your widget/);
  for (const op of ['show', 'load', 'rect', 'play` / `pause', 'mute', 'seek', 'hide']) {
    assert.ok(doc.includes('| `' + op + '`'), `${op} is undocumented`);
  }
  assert.match(doc, /One player exists on a dashboard/);
  assert.match(doc, /96×54 px/);
  assert.match(doc, /Your tile must be on screen/);
});
