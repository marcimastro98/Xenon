// The Twitch watching widget's live list never refreshed.
//
// Reported on Discord: "I can't refresh the live channels — offline channels are
// displayed as live and newly live channels don't pop up." The 60s poll was
// running the whole time; it just had nothing to do. `refresh()` only asked for
// a tab it had NEVER fetched, and `loadTab` returns early when the tab already
// holds data, so the list was read once at first paint and then frozen for as
// long as the tile stayed on screen.
//
// The fix re-reads the current tab on every poll, quietly: no spinner every
// minute, and a failed background read keeps the list that was correct a minute
// ago instead of replacing a good list with an error. `search` is excluded —
// those rows are the user's query, not a live feed. This also un-freezes the
// `twitchWatch` SDK stream, which is fed from the same list via publishWatch().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/twitchwatch-widget.js', import.meta.url), 'utf8');

// The widget is a browser IIFE and cannot be required here, so loadTab is lifted
// out and run against stubs — the same trick discord-favourites.test.mjs uses.
function harness({ connected = true, data = { followed: null, top: null, search: null }, reply } = {}) {
  const at = WIDGET.indexOf("  let bgLoad = '';");
  assert.notEqual(at, -1, 'js/twitchwatch-widget.js must still declare bgLoad');
  const end = WIDGET.indexOf('\n  }', WIDGET.indexOf('async function loadTab(', at)) + 4;
  const src = WIDGET.slice(at, end);
  assert.ok(src.includes('publishWatch();'), 'loadTab must still end at publishWatch');

  const calls = [];
  const paints = { n: 0 };
  const lib = { tab: 'followed', loading: '', error: '', data };
  const ctx = {
    connected,
    lib,
    LIB_PATH: { followed: '/stream/twitch/followed', top: '/stream/twitch/top' },
    paintLibrary: () => { paints.n += 1; },
    publishWatch: () => {},
    api: async (path) => { calls.push(path); return reply ? reply(path) : { ok: true, channels: [{ login: 'a' }] }; },
  };
  // eslint-disable-next-line no-new-func
  const loadTab = new Function('ctx', `
    const { connected, lib, LIB_PATH, paintLibrary, publishWatch, api } = ctx;
    ${src}
    return loadTab;
  `)(ctx);
  return { loadTab, lib, calls, paints };
}

test('a tab that already holds channels is re-read when forced', async () => {
  // The bug in one line: without force the poll asked for nothing.
  const h = harness({ data: { followed: [{ login: 'old' }], top: null, search: null } });
  await h.loadTab('followed');
  assert.deepEqual(h.calls, [], 'unforced, a tab that has data is left alone');
  await h.loadTab('followed', true, true);
  assert.deepEqual(h.calls, ['/stream/twitch/followed'], 'the poll must actually go and look');
  assert.deepEqual(h.lib.data.followed, [{ login: 'a' }], 'and the fresh list replaces the stale one');
});

test('the quiet re-read never puts the spinner up', async () => {
  const h = harness({ data: { followed: [{ login: 'old' }], top: null, search: null } });
  const p = h.loadTab('followed', true, true);
  assert.equal(h.lib.loading, '', 'a background read every 60s must not flash the loading state');
  await p;
  assert.equal(h.lib.loading, '');
});

test('an explicit load still shows the spinner', async () => {
  // Only the poll is quiet; clicking a tab must still say something is happening.
  const h = harness();
  const p = h.loadTab('followed');
  assert.equal(h.lib.loading, 'followed');
  await p;
  assert.equal(h.lib.loading, '');
});

test('a failed background read keeps the last good list instead of blanking it', async () => {
  const h = harness({
    data: { followed: [{ login: 'still-good' }], top: null, search: null },
    reply: async () => ({ ok: false, error: 'network' }),
  });
  await h.loadTab('followed', true, true);
  assert.deepEqual(h.lib.data.followed, [{ login: 'still-good' }], 'a blip must not empty a list that was right a minute ago');
  assert.equal(h.lib.error, '', 'and it must not paint an error over a list that is still on screen');
});

test('a failed explicit load does report the error', async () => {
  const h = harness({ reply: async () => ({ ok: false, error: 'network' }) });
  await h.loadTab('followed');
  assert.equal(h.lib.error, 'network');
});

test('a successful read clears an error left by an earlier failure', async () => {
  const h = harness({ reply: async () => ({ ok: true, channels: [] }) });
  h.lib.error = 'network';
  await h.loadTab('followed');
  assert.equal(h.lib.error, '', 'the error line must go away once the list comes back');
});

test('two background reads of the same tab do not overlap', async () => {
  // The poll fires every 60s; a slow Twitch reply must not stack requests.
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    data: { followed: [{ login: 'old' }], top: null, search: null },
    reply: async () => { await gate; return { ok: true, channels: [] }; },
  });
  const a = h.loadTab('followed', true, true);
  const b = h.loadTab('followed', true, true);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(h.calls, ['/stream/twitch/followed'], 'the second poll must fold into the first');
});

test('a background read does not block the next one once it has finished', async () => {
  const h = harness({ data: { followed: [{ login: 'old' }], top: null, search: null } });
  await h.loadTab('followed', true, true);
  await h.loadTab('followed', true, true);
  assert.equal(h.calls.length, 2, 'bgLoad must be released when the read completes');
});

test('search is never re-read by the poll', async () => {
  const h = harness({ data: { followed: null, top: null, search: [{ login: 'q' }] } });
  await h.loadTab('search', true, true);
  assert.deepEqual(h.calls, [], "search results are the user's query, not a live feed");
});

test('nothing is fetched while no account is connected', async () => {
  const h = harness({ connected: false, data: { followed: [{ login: 'old' }], top: null, search: null } });
  await h.loadTab('followed', true, true);
  assert.deepEqual(h.calls, []);
});

// ── The wiring ───────────────────────────────────────────────────────────────
// The behaviour above is only reached if refresh() actually asks for it.

test('the 60s poll asks the current tab to re-read itself', () => {
  const at = WIDGET.indexOf('async function refresh(');
  assert.notEqual(at, -1);
  const body = WIDGET.slice(at, at + 2000).split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.match(body, /loadTab\(lib\.tab,\s*true,\s*true\)/,
    'refresh() must force a quiet re-read, otherwise the list freezes after the first paint');
  assert.match(body, /lib\.tab !== 'search'/, 'and it must leave the search tab alone');
});

test('the SDK reference states the cadence widgets can now rely on', () => {
  // Behavioural change to a stream a community widget reads: the generator only
  // covers stream NAMES, so the sentence that says the snapshot keeps arriving —
  // and that an empty `live` means nobody is on air rather than a failed read —
  // is written by hand and pinned here.
  const DOC = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  const at = DOC.indexOf('**`twitchWatch`**');
  assert.notEqual(at, -1, 'docs/WIDGET_SDK.md must still document the twitchWatch stream');
  const section = DOC.slice(at, DOC.indexOf('**`twitchChat`**', at));
  assert.match(section, /re-reads the Followed list every 60 s/);
  assert.match(section, /previous snapshot stands/);
});

test('the poll interval is still a minute', () => {
  assert.match(WIDGET, /const POLL_MS = 60000;/);
  assert.match(WIDGET, /poll = setInterval\(refresh, POLL_MS\)/);
});
