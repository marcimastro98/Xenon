// An update still waiting a week after its release has missed every start and
// every quiet moment the automatic install looks for. The notice gets louder,
// never the install: the native app, which otherwise shows only a corner toast,
// opens the full update card once a day, and the toast stays away while it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UPDATE = read('../js/update.js');
const NATIVE = read('../js/native-bridge.js');
const I18N = read('../js/i18n.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 20, 15, 0, 0).getTime();   // local afternoon

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.notEqual(a, -1, from);
  const b = src.indexOf(to, a);
  assert.notEqual(b, -1, to);
  return src.slice(a, b);
}

function fakeStorage({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) { if (broken) throw new Error('off'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('off'); map.set(k, String(v)); },
  };
}

function loadOverdue({ storage = fakeStorage(), now = NOW } = {}) {
  const calls = { modal: [], hide: 0 };
  const window = { XenonNative: { hideUpdatePrompt: () => { calls.hide++; } } };
  const block = slice(UPDATE, '  const OVERDUE_DAYS = 7;', '  function isVersionSkipped(');
  const make = new Function('ctx', `
    const localStorage = ctx.storage;
    const window = ctx.window;
    const Date = ctx.Date;
    const stripV = (s) => String(s || '').replace(/^v/i, '');
    const openModal = (info) => ctx.calls.modal.push(info);
    ${block}
    return { OVERDUE_DAYS, waitingDays, overdueCardDue, showOverdueCard, overdueCardShown };
  `);
  const clock = { now };
  class FakeDate extends globalThis.Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }
  return { ...make({ storage, window, calls, Date: FakeDate }), storage, calls, clock };
}

const info = (daysAgo, over) => ({
  updateAvailable: true, latest: '5.2.0', current: '5.1.1',
  publishedAt: new Date(NOW - daysAgo * DAY).toISOString(), ...over,
});

test('days waiting count from the release date, and only real dates count', () => {
  const o = loadOverdue();
  assert.equal(o.waitingDays(info(9), NOW), 9);
  assert.equal(o.waitingDays(info(6.9), NOW), 6);
  assert.equal(o.waitingDays({ publishedAt: '' }, NOW), 0);
  assert.equal(o.waitingDays({ publishedAt: 'soon' }, NOW), 0);
  assert.equal(o.waitingDays(info(-2), NOW), 0, 'a date in the future is not a wait');
  assert.equal(o.waitingDays(null, NOW), 0);
});

test('the card is due from the seventh day, for a real pending update only', () => {
  const o = loadOverdue();
  assert.equal(o.OVERDUE_DAYS, 7);
  assert.equal(o.overdueCardDue(info(6), NOW), false);
  assert.equal(o.overdueCardDue(info(7), NOW), true);
  assert.equal(o.overdueCardDue(info(30), NOW), true);
  assert.equal(o.overdueCardDue(info(30, { updateAvailable: false }), NOW), false);
  assert.equal(o.overdueCardDue(info(30, { publishedAt: '' }), NOW), false);
});

test('once a day: shown today, not again today; back tomorrow', () => {
  const o = loadOverdue();
  const i = info(8);
  assert.equal(o.overdueCardDue(i, NOW), true);
  o.showOverdueCard(i);
  assert.equal(o.calls.modal.length, 1);
  assert.equal(o.overdueCardDue(i, NOW), false, 'same day');
  assert.equal(o.overdueCardDue(i, NOW + 6 * 60 * 60 * 1000), false, 'later the same day');
  assert.equal(o.overdueCardDue(i, NOW + DAY), true, 'the next day');
  assert.equal(o.overdueCardDue(info(8, { latest: '5.2.1' }), NOW), true, 'a newer release is a new notice');
});

test('without storage the card still shows: a missed notice is the worse failure', () => {
  const o = loadOverdue({ storage: fakeStorage({ broken: true }) });
  assert.equal(o.overdueCardDue(info(8), NOW), true);
  assert.doesNotThrow(() => o.showOverdueCard(info(8)));
  assert.equal(o.calls.modal.length, 1);
});

test('the card takes the toast away and keeps it away for that version', () => {
  const o = loadOverdue();
  assert.equal(o.overdueCardShown('5.2.0'), false, 'nothing shown yet');
  o.showOverdueCard(info(8, { latest: 'v5.2.0' }));
  assert.equal(o.calls.hide, 1, 'the corner toast is closed');
  assert.equal(o.overdueCardShown('5.2.0'), true);
  assert.equal(o.overdueCardShown('v5.2.0'), true);
  assert.equal(o.overdueCardShown(''), true, 'the shell may not say which version');
  assert.equal(o.overdueCardShown('5.3.0'), false, 'another version still gets its toast');
});

// ── The native toast honours it ──────────────────────────────────────────────

function loadToast({ overdue = false, skipped = false } = {}) {
  const shown = [];
  const dismissed = [];
  const window = {
    XenonToast: { show: (o) => { shown.push(o); return 41; }, dismiss: (id) => dismissed.push(id) },
    XenonUpdate: { isVersionSkipped: () => skipped, overdueCardShown: () => overdue },
  };
  const block = slice(NATIVE, '  let updatePromptShown = false;', '  // ── Browser / iCUE:');
  const make = new Function('ctx', `
    const window = ctx.window;
    const isNative = true;
    const tr = (k, f) => f;
    ${block}
    return { showUpdatePrompt, hideUpdatePrompt };
  `);
  return { ...make({ window }), shown, dismissed };
}

test('the native toast stays away while the week-old card is up', () => {
  const t = loadToast({ overdue: true });
  t.showUpdatePrompt('5.2.0');
  assert.equal(t.shown.length, 0);
  const plain = loadToast();
  plain.showUpdatePrompt('5.2.0');
  assert.equal(plain.shown.length, 1, 'otherwise the toast as before');
});

test('hideUpdatePrompt closes the toast it showed, and only that one', () => {
  const t = loadToast();
  t.hideUpdatePrompt();
  assert.deepEqual(t.dismissed, [], 'nothing to close yet');
  t.showUpdatePrompt('5.2.0');
  t.hideUpdatePrompt();
  assert.deepEqual(t.dismissed, [41]);
  t.hideUpdatePrompt();
  assert.deepEqual(t.dismissed, [41], 'closed once');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('boot: the web modal is unchanged, the native app gets the card only when due', () => {
  const boot = slice(UPDATE, '  async function boot() {', '  // What\'s New of the running build');
  assert.match(boot, /if \(updatePending && !isNativeShell\(\)\) queue\.push\(\(next\) => \{ openModal\(info\); next\(\); \}\);/);
  assert.match(boot, /else if \(updatePending && overdueCardDue\(info, Date\.now\(\)\)\) queue\.push\(\(next\) => \{ showOverdueCard\(info\); next\(\); \}\);/);
  assert.match(UPDATE, /overdueCardShown,\n  \};/);
  // It never installs: the card is the same one the Settings pill opens.
  const block = slice(UPDATE, '  const OVERDUE_DAYS = 7;', '  function isVersionSkipped(');
  assert.doesNotMatch(block, /nativeUpdateFlow|\/update\/apply|\/update\/prepare|xenon-update:install/);
});

test('the card says how long it has waited, in every language', () => {
  assert.match(UPDATE, /tr\('update_waiting_days', 'In attesa da \{n\} giorni'\)\.replace\('\{n\}', String\(waited\)\)/);
  const keys = I18N.match(/update_waiting_days: '[^']*\{n\}[^']*'/g) || [];
  assert.equal(keys.length, 11, 'it en ko ja zh es fr de pt ru nl');
});
