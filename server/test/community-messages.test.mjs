// Hub message feed (community-messages.js) — shape validation for a document
// fetched from the project site and rendered on the dashboard. Everything here
// is about what a remote JSON is allowed to make the UI do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../community-messages.js');

const msg = (over = {}) => ({ id: 'v490-release', level: 'toast', title: 'Xenon 4.9.0', ...over });

// ── Identity and level ─────────────────────────────────────────────────────
test('a message needs a charset-pinned id, a known level and a title', () => {
  assert.ok(M.normalizeMessage(msg()));
  assert.equal(M.normalizeMessage(msg({ id: '' })), null);
  assert.equal(M.normalizeMessage(msg({ id: '../escape' })), null);
  assert.equal(M.normalizeMessage(msg({ id: 'Has-Capitals' })), null);
  assert.equal(M.normalizeMessage(msg({ level: 'fullscreen' })), null);
  assert.equal(M.normalizeMessage(msg({ level: '' })), null);
  assert.equal(M.normalizeMessage(msg({ title: '   ' })), null);
  assert.equal(M.normalizeMessage(null), null);
  assert.equal(M.normalizeMessage([]), null);
});

test('text is bounded and unknown keys never reach the client', () => {
  const out = M.normalizeMessage(msg({
    title: 'T'.repeat(500),
    body: 'B'.repeat(2000),
    kicker: 'K'.repeat(100),
    onClick: 'alert(1)',        // not a key this shape has
    html: '<script>x</script>', // nor this
  }));
  assert.equal(out.title.length, 120);
  assert.equal(out.body.length, 600);
  assert.equal(out.kicker.length, 24);
  assert.deepEqual(Object.keys(out).sort(), ['body', 'id', 'kicker', 'level', 'title']);
});

// ── Actions ────────────────────────────────────────────────────────────────
test('a url action is https-only and restricted to the known hosts', () => {
  const withAction = (action) => M.normalizeMessage(msg({ action }));
  const ok = withAction({ type: 'url', label: 'Read', url: 'https://xenon-app.com/changelog' });
  assert.equal(ok.action.url, 'https://xenon-app.com/changelog');

  // The feed is the one place a remote document puts a link on the dashboard.
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'http://xenon-app.com' }).action, undefined);
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'https://evil.example.com' }).action, undefined);
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'javascript:alert(1)' }).action, undefined);
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'data:text/html,x' }).action, undefined);
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'https://127.0.0.1:3030/notes?save=x' }).action, undefined);
  // A lookalike host must not pass on a prefix/suffix match.
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'https://xenon-app.com.evil.tld' }).action, undefined);
  assert.equal(withAction({ type: 'url', label: 'Go', url: 'https://notgithub.com' }).action, undefined);
});

test('an action needs a label and a type the client knows', () => {
  const withAction = (action) => M.normalizeMessage(msg({ action }));
  assert.equal(withAction({ type: 'url', url: 'https://github.com/x' }).action, undefined, 'no label');
  assert.equal(withAction({ type: 'exec', label: 'Run' }).action, undefined);
  assert.equal(withAction({ label: 'Go' }).action, undefined, 'no type');
  assert.equal(withAction('dismiss').action, undefined);
  assert.deepEqual(withAction({ type: 'dismiss', label: 'OK' }).action, { type: 'dismiss', label: 'OK' });
});

test('a store action only survives when the message names an entry to open', () => {
  const action = { type: 'store', label: 'Open in Store' };
  assert.equal(M.normalizeMessage(msg({ action })).action, undefined);
  const withEntry = M.normalizeMessage(msg({ action, entryId: 'neon-pack' }));
  assert.deepEqual(withEntry.action, action);
  assert.equal(withEntry.entryId, 'neon-pack');
  // A bad entry id is dropped, and takes the store CTA with it.
  assert.equal(M.normalizeMessage(msg({ action, entryId: '../x' })).entryId, undefined);
});

// ── Targeting ──────────────────────────────────────────────────────────────
test('a valid match block is rebuilt key by key', () => {
  const out = M.normalizeMessage(msg({
    match: {
      minVersion: '4.9.0', maxVersion: '4.9.9',
      os: ['win32', 'linux'], lang: ['it'],
      hasEntry: ['dgm-news', 'neon-pack'], supporter: true,
      secretKey: 'dropped',
    },
  }));
  assert.deepEqual(out.match, {
    minVersion: '4.9.0', maxVersion: '4.9.9',
    os: ['win32', 'linux'], lang: ['it'],
    hasEntry: ['dgm-news', 'neon-pack'], supporter: true,
  });
});

test('an absent match block means everyone', () => {
  assert.equal(M.normalizeMessage(msg()).match, undefined);
  assert.equal(M.normalizeMatch(undefined), null);
  assert.equal(M.normalizeMatch(null), null);
  assert.equal(M.normalizeMatch({}), null);
});

// This is the rule worth breaking a message over: a filter that was MEANT to
// narrow the audience and failed to parse must not widen it to everyone.
test('a match block that is present but invalid drops the message entirely', () => {
  assert.equal(M.normalizeMessage(msg({ match: { minVersion: 'latest' } })), null);
  assert.equal(M.normalizeMessage(msg({ match: { os: ['Windows 11'] } })), null);
  assert.equal(M.normalizeMessage(msg({ match: { os: [] } })), null);
  assert.equal(M.normalizeMessage(msg({ match: { hasEntry: ['../etc'] } })), null);
  assert.equal(M.normalizeMessage(msg({ match: { supporter: 'yes' } })), null);
  assert.equal(M.normalizeMessage(msg({ match: [] })), null);
  assert.equal(M.normalizeMessage(msg({ match: 'supporters' })), null);
});

// Found by the admin-side validator: the token was TRUNCATED to its cap before
// being tested, so 'italiano' became a valid 'it' and the message silently
// targeted a language nobody chose. Over-length input must fail, not be cut down.
test('an over-length token is rejected, never shortened into a valid one', () => {
  // Whole list invalid -> unsatisfiable -> the message is dropped entirely.
  assert.equal(M.normalizeMessage(msg({ match: { lang: ['italiano'] } })), null);
  assert.equal(M.normalizeMessage(msg({ match: { os: ['win32-but-far-too-long'] } })), null);
  // A valid sibling survives; the bad token is simply not part of the filter.
  assert.deepEqual(M.normalizeMessage(msg({ match: { lang: ['it', 'english'] } })).match.lang, ['it']);
});

test('match lists are bounded and de-duplicated', () => {
  const many = Array.from({ length: 50 }, (_, i) => 'entry-' + i);
  const out = M.normalizeMessage(msg({ match: { hasEntry: many.concat(many) } }));
  assert.equal(out.match.hasEntry.length, 20);
  const dup = M.normalizeMessage(msg({ match: { os: ['win32', 'win32', 'linux'] } }));
  assert.deepEqual(dup.match.os, ['win32', 'linux']);
});

// ── Feed level ─────────────────────────────────────────────────────────────
test('the feed accepts either an array or a {messages} envelope', () => {
  const one = [msg()];
  assert.equal(M.normalizeMessages(one).length, 1);
  assert.equal(M.normalizeMessages({ messages: one }).length, 1);
  assert.deepEqual(M.normalizeMessages(null), []);
  assert.deepEqual(M.normalizeMessages({}), []);
  assert.deepEqual(M.normalizeMessages('nope'), []);
});

test('invalid messages are skipped without taking the feed down', () => {
  const out = M.normalizeMessages([msg({ id: 'a' }), null, msg({ id: '' }), msg({ id: 'b' })]);
  assert.deepEqual(out.map((m) => m.id), ['a', 'b']);
});

test('duplicate ids are dropped so the seen-set dedup stays unambiguous', () => {
  const out = M.normalizeMessages([msg({ id: 'a', title: 'First' }), msg({ id: 'a', title: 'Second' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'First');
});

test('the feed is capped', () => {
  const many = Array.from({ length: 200 }, (_, i) => msg({ id: 'm-' + i }));
  assert.equal(M.normalizeMessages(many).length, M.MAX_MESSAGES);
});

// ── Scheduling ─────────────────────────────────────────────────────────────
test('messages outside their date window are filtered at serve time', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  const list = M.normalizeMessages([
    msg({ id: 'live' }),
    msg({ id: 'future', activeFrom: '2026-08-01' }),
    msg({ id: 'past', activeUntil: '2026-07-01' }),
    msg({ id: 'window', activeFrom: '2026-07-01', activeUntil: '2026-08-01' }),
  ]);
  const visible = M.filterVisibleMessages(list, now).map((m) => m.id);
  assert.deepEqual(visible, ['live', 'window']);
});

// A date picker set to 1 August means "through 1 August". Comparing against the
// bare parse (midnight UTC) dropped the campaign's entire last day.
test('a bare end date includes the whole of that day', () => {
  const list = M.normalizeMessages([msg({ id: 'ends-aug1', activeUntil: '2026-08-01' })]);
  const visibleAt = (iso) => M.filterVisibleMessages(list, Date.parse(iso)).length === 1;
  assert.equal(visibleAt('2026-08-01T00:00:00Z'), true, 'the first second of the last day');
  assert.equal(visibleAt('2026-08-01T14:00:00Z'), true, 'the middle of the last day');
  assert.equal(visibleAt('2026-08-01T23:59:59Z'), true, 'the last second of the last day');
  assert.equal(visibleAt('2026-08-02T00:00:01Z'), false, 'and gone the next day');
});

test('an end date WITH a time is honoured exactly as written', () => {
  // Stretching this one to end-of-day would override an author who said when.
  const list = M.normalizeMessages([msg({ id: 'ends-noon', activeUntil: '2026-08-01T12:00:00Z' })]);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-08-01T11:59:00Z')).length, 1);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-08-01T12:01:00Z')).length, 0);
});

test('a start date still begins at the start of its day', () => {
  const list = M.normalizeMessages([msg({ id: 'starts-aug1', activeFrom: '2026-08-01' })]);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-07-31T23:59:00Z')).length, 0);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-08-01T00:00:01Z')).length, 1);
});

test('a single-day window covers exactly that day', () => {
  const list = M.normalizeMessages([msg({ id: 'one-day', activeFrom: '2026-08-01', activeUntil: '2026-08-01' })]);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-08-01T09:00:00Z')).length, 1);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-07-31T23:00:00Z')).length, 0);
  assert.equal(M.filterVisibleMessages(list, Date.parse('2026-08-02T01:00:00Z')).length, 0);
});

test('an unparseable date is ignored rather than hiding the message forever', () => {
  const out = M.normalizeMessage(msg({ activeFrom: 'next tuesday' }));
  assert.equal(out.activeFrom, undefined);
  assert.equal(M.filterVisibleMessages([out], Date.now()).length, 1);
});

// ── Cache freshness ────────────────────────────────────────────────────────
test('cacheIsFresh needs a real message array inside the TTL', () => {
  const now = 1_000_000;
  assert.equal(M.cacheIsFresh(null, now), false);
  assert.equal(M.cacheIsFresh({ fetchedAt: now }, now), false, 'no messages array');
  assert.equal(M.cacheIsFresh({ messages: [], fetchedAt: now }, now), true);
  assert.equal(M.cacheIsFresh({ messages: [], fetchedAt: now - 31 * 60 * 1000 }, now), false);
});

/* ── endpoint wiring ──────────────────────────────────────────────────────────
   The feed reaches the dashboard through GET /api/community/messages. Two
   properties of that route are load-bearing and easy to lose in a later edit, so
   pin them against the source rather than trusting the comment next to them. */
import fs from 'node:fs';

const SERVER_SRC = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const setBody = (name) => {
  const start = SERVER_SRC.indexOf(`const ${name} = new Set([`);
  assert.ok(start > 0, name + ' not found');
  return SERVER_SRC.slice(start, SERVER_SRC.indexOf(']);', start));
};

test('the feed endpoint is guarded against a cross-site drive-by', () => {
  // ?refresh=1 makes the local server hit the network, so a <script>/<img> from
  // any visited page must not be able to drive it.
  assert.match(setBody('CSRF_MUTATION_PATHS'), /'\/api\/community\/messages'/);
});

test('the feed endpoint is never JSONP-reachable', () => {
  // JSONP wraps the response for any page that can load a <script>. This feed is
  // not sensitive today, but the allowlist is for read-only iCUE endpoints only
  // and nothing here should quietly join it.
  assert.doesNotMatch(setBody('JSONP_PATHS'), /community/);
});

/* ── Polls ────────────────────────────────────────────────────────────────────
   A poll rides a message: title/body ask, options answer. The rule that matters
   is that a poll which fails validation takes the whole message with it — a
   question with no way to answer it reads as broken, not as an announcement. */
const poll = (options) => msg({ id: 'poll-1', level: 'modal', title: 'Which?', poll: { options } });

test('a valid poll is kept as id/label pairs', () => {
  const out = M.normalizeMessage(poll([{ id: 'deck', label: 'A bigger Deck' }, { id: 'ai', label: 'Smarter AI' }]));
  assert.deepEqual(out.poll, { options: [{ id: 'deck', label: 'A bigger Deck' }, { id: 'ai', label: 'Smarter AI' }] });
});

test('a poll needs at least two answers', () => {
  assert.equal(M.normalizeMessage(poll([{ id: 'a', label: 'Only one' }])), null);
  assert.equal(M.normalizeMessage(poll([])), null);
});

test('an invalid poll drops the message rather than shipping an unanswerable question', () => {
  assert.equal(M.normalizeMessage(poll([{ id: '../x', label: 'A' }, { id: 'B!', label: 'B' }])), null);
  assert.equal(M.normalizeMessage(poll([{ id: 'a', label: '' }, { id: 'b', label: 'B' }])), null);
  assert.equal(M.normalizeMessage(msg({ poll: 'yes/no' })), null);
  assert.equal(M.normalizeMessage(msg({ poll: { options: 'a,b' } })), null);
});

test('duplicate option ids are collapsed, and the ballot is capped', () => {
  // Two buttons with different words incrementing one counter would make the
  // result unreadable.
  const dup = M.normalizeMessage(poll([{ id: 'a', label: 'A' }, { id: 'a', label: 'Also A' }, { id: 'b', label: 'B' }]));
  assert.deepEqual(dup.poll.options.map((o) => o.id), ['a', 'b']);
  const many = M.normalizeMessage(poll(Array.from({ length: 9 }, (_, i) => ({ id: 'o' + i, label: 'O' + i }))));
  assert.equal(many.poll.options.length, 5);
});

test('a message without a poll key is unaffected', () => {
  assert.equal('poll' in M.normalizeMessage(msg()), false);
  assert.ok(M.normalizeMessage(msg({ poll: null })));
});

test('option labels are bounded', () => {
  const out = M.normalizeMessage(poll([{ id: 'a', label: 'L'.repeat(300) }, { id: 'b', label: 'B' }]));
  assert.equal(out.poll.options[0].label.length, 60);
});
