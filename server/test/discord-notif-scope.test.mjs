// Knowing a Discord re-link is needed BEFORE waiting for it to fail.
//
// The notification scope is requested only when notifications are on at the
// moment the account is linked. Turn them on afterwards and the grant does not
// have it — and reconnecting cannot add it, because Discord's RPC AUTHORIZE
// reuses an existing authorization and returns a code for the scopes already
// granted. The grant has to be removed in User Settings → Authorizations first.
//
// Until now the app only found out by trying: the watch subscribed, Discord
// refused, and the warning appeared after the wait. It was reported as the error
// persisting "even after reconnecting" — which is what the app itself had
// implicitly suggested by saying nothing when the switch went on.
//
// So the stored token now records what the grant covers, and the switch can say
// so immediately. The care is in the third answer: a token issued before this
// was recorded knows nothing, and must not be read as a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { notifScopeState, NOTIF_SCOPE } = require('../discord-rpc.js');
const { makeCredsNormalizer } = require('../stream-common.js');

const PAGE = readFileSync(new URL('../js/streaming-page.js', import.meta.url), 'utf8');
const COMMON = readFileSync(new URL('../stream-common.js', import.meta.url), 'utf8');
const RPC = readFileSync(new URL('../discord-rpc.js', import.meta.url), 'utf8');

// ── Reading the grant ────────────────────────────────────────────────────────

test('a grant that carries the notification scope reads as granted', () => {
  assert.equal(notifScopeState(`rpc identify ${NOTIF_SCOPE}`), 'granted');
  assert.equal(notifScopeState(`${NOTIF_SCOPE}`), 'granted');
  // Discord returns them space-separated; order is not ours to assume.
  assert.equal(notifScopeState(`${NOTIF_SCOPE} rpc rpc.voice.read`), 'granted');
});

test('a grant without it reads as missing — the case that was reported', () => {
  assert.equal(notifScopeState('rpc rpc.voice.read rpc.voice.write identify'), 'missing');
});

// The one that decides whether this change is safe to ship. Every token issued
// before the scope was recorded has no scope string, and reading that as a
// refusal would put a re-link warning in front of users whose notifications
// have been working for months.
test('a token from before this was recorded is unknown, never missing', () => {
  for (const value of ['', '   ', null, undefined, 0, false]) {
    assert.equal(notifScopeState(value), 'unknown', JSON.stringify(value));
  }
});

// A near miss must not read as granted: `rpc.notifications` is not the scope,
// and a substring match would say it is.
test('a scope that merely looks similar is not the scope', () => {
  assert.equal(notifScopeState('rpc rpc.notifications identify'), 'missing');
  assert.equal(notifScopeState('rpc.notifications.readable'), 'missing');
});

// ── Storing it ───────────────────────────────────────────────────────────────

test('the Discord normalizer keeps the scope, and bounds it', () => {
  const normalize = makeCredsNormalizer({ userId: 40, username: 100, scope: 400 });
  const kept = normalize({ accessToken: 'a', scope: `rpc ${NOTIF_SCOPE}` });
  assert.equal(kept.scope, `rpc ${NOTIF_SCOPE}`);
  assert.equal(normalize({ scope: 'x'.repeat(1000) }).scope.length, 400);
  // Junk in the store must not become a scope claim.
  assert.equal(normalize({ scope: { evil: true } }).scope, '');
  assert.equal(normalize({}).scope, '');
});

// The writer is shared with Twitch, whose normalizer declares no scope — so it
// is offered to everyone and kept only where it was asked for.
test('offering the scope to every provider costs the others nothing', () => {
  const twitchLike = makeCredsNormalizer({ login: 120, userId: 60 });
  assert.ok(!('scope' in twitchLike({ accessToken: 'a', scope: 'anything' })));
});

// A refresh response may omit `scope` — the grant has not changed, so dropping
// it there would turn a known 'granted' into 'unknown' at the next refresh and
// quietly disable the eager warning.
test('a refresh that omits the scope keeps the stored one', () => {
  assert.match(COMMON, /scope: data\.scope \|\| current\.scope \|\| ''/);
});

// ── What the switch does with it ─────────────────────────────────────────────

test('the warning appears on a known-missing grant, not only after a failure', () => {
  const line = PAGE.slice(PAGE.indexOf('const relinkNeeded'));
  const expr = line.slice(0, line.indexOf(';') + 1);
  assert.match(expr, /st\.notifScope === 'missing'/, 'the grant is read directly');
  assert.match(expr, /st\.notif === 'scope_missing'/, 'the confirmed failure stays as the backstop');
  assert.match(expr, /st\.connected/, 'nothing to re-link when not connected');
  // 'unknown' must never reach the warning — neither by name nor by a truthiness
  // test that would catch it.
  assert.ok(!/notifScope\s*!==\s*'granted'/.test(expr), 'that form would warn on unknown too');
});

test('status reports the grant to the page that renders the switch', () => {
  const status = RPC.slice(RPC.indexOf('async function status()'));
  assert.match(status.slice(0, status.indexOf('\n  }')), /notifScope: notifScopeState\(c\.scope\)/);
});

// The scope is requested at link time only, which is the whole reason this state
// exists. Pinned so the eager warning cannot be quietly made pointless (or
// wrong) by a change that starts requesting it unconditionally without also
// revisiting the message.
test('the notification scope is still asked for only when it is wanted', () => {
  assert.match(RPC, /wantNotifications\(\) \? SCOPES\.concat\(\[NOTIF_SCOPE\]\) : SCOPES/);
});
