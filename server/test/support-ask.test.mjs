// The one-time supporter ask.
//
// Xenon has had a donate button since the beginning — in the app, on the site, on
// GitHub, on Discord — and it has never asked, so only people who went looking
// ever found it. This asks once, and the rules around that "once" are the whole
// design: get any of them wrong and an ask becomes a nag, which is worse than
// never asking at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARD = readFileSync(new URL('../js/support-card.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

test('the gate is thirty days AND ten separate days of use', () => {
  assert.match(CARD, /const DAYS_SINCE_FIRST_RUN = 30;/);
  assert.match(CARD, /const DISTINCT_DAYS_USED = 10;/);
  const fn = CARD.slice(CARD.indexOf('async function maybeShow()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /daysSince\(use\.firstRunDay\) < DAYS_SINCE_FIRST_RUN\) return;/);
  assert.match(body, /use\.usageDays < DISTINCT_DAYS_USED\) return;/);
});

// A day of use means a dashboard was opened. An engine that starts at logon on a
// PC nobody looks at must not accumulate credit toward being asked for money.
test('a day is counted when a dashboard connects, once, and not per launch', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function noteUsageDay()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(cur\.lastUsageDay === today\) return;/, 'at most one write a day');
  assert.match(body, /if \(prev\.lastUsageDay === today\) return;/, 'and re-checked under the lock');
  assert.match(body, /firstRunDay: prev\.firstRunDay \|\| today/, 'the first run is stamped once');
  assert.match(body, /usageDays: \(Number\(prev\.usageDays\) \|\| 0\) \+ 1/);
  // Wired to the SSE connect, which is the "somebody is looking at it" signal.
  const sse = SERVER.slice(SERVER.indexOf('noteUsageDay();'));
  assert.match(sse.slice(0, 200), /Push current state immediately/, 'called where a dashboard connects');
});

// The counters are server-owned. A generic save arrives without them, and
// rebuilding them from defaults would reset the clock — and let a once-per-install
// ask come round again.
test('a client save cannot reset the usage history', () => {
  const post = SERVER.slice(SERVER.indexOf("reqPath === '/settings' && req.method === 'POST'"));
  const block = post.slice(0, post.indexOf('} else if (reqPath'));
  assert.match(block, /if \(prev\.firstRunDay\) incoming\.firstRunDay = prev\.firstRunDay;/);
  assert.match(block, /if \(prev\.lastUsageDay\) incoming\.lastUsageDay = prev\.lastUsageDay;/);
  assert.match(block, /if \(Number\(prev\.usageDays\) > 0\) incoming\.usageDays = prev\.usageDays;/);
  // …and the dismissal only ever travels one way, so a stale mirror cannot
  // un-dismiss a card the user already answered.
  assert.match(block, /if \(prev\.supportAskSeen === true\) incoming\.supportAskSeen = true;/);
});

// The flag is on disk, not in localStorage: a browser set to clear its site data
// would otherwise put this back every few weeks, which is the difference between
// an ask and a nag.
test('the dismissal lives in hub settings, never in localStorage', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function rememberSupportAskSeen()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /supportAskSeen: true/);
  assert.doesNotMatch(body, /localStorage/, 'no per-device copy: that is the bug this avoids');
  assert.match(SETTINGS, /function supportAskDismissed\(\)[\s\S]{0,160}hubSettings\.supportAskSeen === true/);
});

// Before the server copy lands, the local mirror of a site-data-clearing browser
// reads as a brand-new install — exactly when the card must not go up.
test('nothing is decided before the stored answer is known', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function usageHistory()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!_hubHydratedFromServer\) return null;/);
  const gate = CARD.slice(CARD.indexOf('async function maybeShow()'));
  assert.match(gate.slice(0, gate.indexOf('\n  }')), /if \(!use\) return;/, 'and the card honours the null');
});

// Asking someone who already gives is the error that cannot be taken back.
test('a machine holding a supporter pass is never asked', () => {
  const fn = CARD.slice(CARD.indexOf('async function alreadySupporter()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /\/api\/community\/supporter/);
  assert.match(body, /return !\(d && d\.ok && d\.saved === false\);/, 'only an explicit "no" means no');
  assert.match(body, /catch \{ return true; \}/, 'and any failure errs toward not asking');
});

// The pass check only sees a code REDEEMED in the app, so a supporter who never
// claimed their perks would still be asked. That button is the way out — and it
// sends them to claim what they already paid for.
test('there is a way out for a supporter the check cannot see', () => {
  assert.match(CARD, /support_ask_already/);
  const fn = CARD.slice(CARD.indexOf("already.addEventListener"));
  const body = fn.slice(0, fn.indexOf('\n    });'));
  assert.match(body, /remember\(\);/, 'it silences the card for good');
  assert.match(body, /settingsSetCategory\('support'\)/, 'and opens where a pass is entered');
});

// The moments Xenon is being used for something. Same body-class convention the
// toast do-not-disturb already reads.
test('it never interrupts a voice session, the lock screen, a game or a scene', () => {
  const fn = CARD.slice(CARD.indexOf('function busyRightNow()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  for (const cls of ['lock-screen-active', 'ai-voice-mode', 'ai-listening', 'game-mode',
    'ambient-scene-open', 'ambient-canvas-open']) {
    assert.match(body, new RegExp(cls), `${cls} holds the card back`);
  }
  assert.match(body, /catch \{ return true; \}/, 'if it cannot tell, it does not interrupt');
  // Re-checked at the last moment: the wait is long enough for one to have begun.
  const show = CARD.slice(CARD.indexOf('setTimeout(() => {', CARD.indexOf('async function maybeShow()')));
  assert.match(show.slice(0, 400), /if \(busyRightNow\(\)\) return;/);
});

test('monthly is the offer, one-off is the alternative', () => {
  assert.ok(CARD.indexOf('support_ask_monthly') < CARD.indexOf('support_ask_once'),
    'the monthly button comes first');
  assert.match(CARD, /BMC_MONTHLY = BMC \+ '\/membership'/, 'and it opens the membership page');
  assert.match(readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8'),
    /\.support-ask-monthly \{ background: var\(--accent/, 'it is the filled button');
});

test('the card is loaded, styled, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-card\.js"><\/script>/);
  assert.match(HTML, /components\/SupportAsk\/SupportAsk\.css/);
  for (const key of ['support_ask_title', 'support_ask_text', 'support_ask_perks',
    'support_ask_monthly', 'support_ask_once', 'support_ask_already']) {
    const found = new Set();
    let current = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) current = ns[1];
      const t = line.trimStart();
      if (t.startsWith(key + ':') || t.startsWith('"' + key + '":')) found.add(current);
    }
    const missing = LANGS.filter((l) => !found.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});
