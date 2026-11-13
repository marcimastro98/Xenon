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
import { appStringsSource, appStrings, textsOf } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const CARD = readFileSync(new URL('../js/support-card.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = engineSource();
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = appStringsSource();
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

// The answer to "I already support Xenon" is shared with the December appeal,
// so it lives in its own function rather than inside the button handler.
function thankSupporterBody() {
  const fn = CARD.slice(CARD.indexOf('function thankSupporter()'));
  return fn.slice(0, fn.indexOf('\n  }'));
}

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
  assert.match(body, /silenceAppeal\(\);/, 'and the December appeal with it');
  assert.match(body, /thankSupporter\(\);/, 'then answers them');
  assert.match(thankSupporterBody(), /settingsSetCategory\('support'\)/, 'and opens where a pass is entered');
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
  // The ask itself is one of Bit's messages, which waits through the same moments
  // (js/bit-messages.js quiet()).
  assert.doesNotMatch(CARD, /document\.body\.appendChild|getElementById\('support-ask'\)/, 'no card of its own');
  assert.match(CARD, /window\.XenonSupportAsk = \{[^}]*busyRightNow/, 'kept for the December appeal');
});

// Three objects you get, each with its own glyph. The same three facts in one
// sentence were skimmed past, which is what made the card read as small print.
test('the perks are a list of things, not a sentence about them', () => {
  const fn = CARD.slice(CARD.indexOf("perks.className = 'bm-perks'"));
  const body = fn.slice(0, fn.indexOf('\n    });'));
  for (const key of ['support_perk_themes', 'support_perk_discord', 'support_perk_name']) {
    assert.match(body, new RegExp(key), key + ' is its own row');
  }
  assert.match(body, /createElement\('li'\)/, 'rendered as list items');
  assert.match(body, /bm-perk-icon/, 'each with its own glyph');
});

// Pressing it used to close the card and silently open a settings page, which
// from the outside looks like nothing happened -- the first question asked about
// this card was "what does that button even do?".
test('"I already support Xenon" says what it just did', () => {
  const body = thankSupporterBody();
  assert.match(body, /support_thanks_title/, 'it thanks them');
  assert.match(body, /support_thanks_msg/, 'and says where the code goes');
  assert.match(body, /important: true/, 'the reply to a press is never held back by quiet hours');
});

// Plain speech. The em dash is the tell of text written to sound impressive
// rather than to be read, and it was the first thing called out on the draft.
test('the card speaks plainly, with no em dashes', () => {
  let checked = 0;
  for (const key of Object.keys(appStrings().en).filter((k) => /support_(?:ask|perk|thanks)_[a-z]+$/.test(k))) {
    for (const [lang, text] of textsOf(key)) {
      checked++;
      assert.ok(!text.includes('—'), 'em dash in ' + lang + '.' + key);
    }
  }
  assert.ok(checked >= 110, 'every card string was checked, in every language');
});

test('monthly is the offer, one-off is the alternative', () => {
  assert.ok(CARD.indexOf('support_letter_monthly') > 0 && CARD.indexOf('support_letter_monthly') < CARD.indexOf('support_letter_once'),
    'the monthly button comes first');
  assert.match(CARD, /open\(supportLink\('monthly'\)\)/, 'and it opens the membership page');
  assert.match(CARD, /plan === 'once' \? BMC : BMC \+ '\/membership'/,
    'which is also where the fallback goes when the shared module is missing');
  assert.match(CARD, /c\.supportUrl\('app-ask', plan\)/, 'counted under its own label');
});

test('the card is loaded, styled, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-card\.js"><\/script>/);
  assert.match(HTML, /components\/SupportAsk\/SupportAsk\.css/);
  for (const key of ['support_ask_title', 'support_letter_text',
    'support_perk_themes', 'support_perk_discord', 'support_perk_name',
    'support_ask_monthly', 'support_ask_once', 'support_ask_already',
    'support_thanks_title', 'support_thanks_msg']) {
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

// ── The message, run ───────────────────────────────────────────────────────
// The gate passing files ONE of Bit's messages and remembers the ask; opening
// the card draws the offer. Run against DOM stubs.
async function runAsk({ credits = true, dismissed = false, supporter = false, unreachable = false, use = { firstRunDay: '2000-01-01', usageDays: 40 } } = {}) {
  const el = (tag) => ({
    tag, className: '', type: '', textContent: '', innerHTML: '', children: [], on: {},
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { this.on[t] = fn; }, setAttribute() {},
  });
  const posted = [];
  const kinds = {};
  const opened = [];
  let remembered = 0;
  let silenced = 0;
  const window = {
    BitMessages: {
      file: async (list) => { posted.push(...list); return !unreachable; },
      kind: (k, parts) => { kinds[k] = parts; },
      firstLine: (text) => text,
    },
    XenonStartupCards: {
      supportAskDismissed: () => dismissed, usageHistory: () => use,
      rememberSupportAsk: () => { remembered++; }, silenceSupportAppeal: () => { silenced++; },
    },
    open: (u) => opened.push(u),
  };
  if (credits) window.XenonCredits = { offerMark: () => ({ ...el('span'), sprite: true }) };
  const document = { readyState: 'complete', createElement: el, body: { appendChild() { throw new Error('no card on screen'); } } };
  const fetch = async () => ({ json: async () => ({ ok: true, saved: supporter }) });
  new Function('window', 'document', 'fetch', 'requestAnimationFrame', CARD)(window, document, fetch, () => {});
  await new Promise((r) => setTimeout(r, 5));
  return { posted, kinds, opened, el, get remembered() { return remembered; }, get silenced() { return silenced; } };
}
const all = (n) => (n ? [n, ...(n.children || []).flatMap(all)] : []);

test('the ask is filed once as a message, and remembered once it is filed', async () => {
  const d = await runAsk();
  assert.equal(d.posted.length, 1);
  assert.equal(d.posted[0].id, 'support:ask');
  assert.equal(d.posted[0].kind, 'support');
  assert.equal(d.posted[0].surface, 'dashboard', 'a payment page does not open from the widgets window');
  assert.equal(d.remembered, 1, 'once means once, read or not');
  assert.equal((await runAsk({ unreachable: true })).remembered, 0, 'not filed, not spent');
  assert.equal((await runAsk({ dismissed: true })).posted.length, 0, 'never twice');
  assert.equal((await runAsk({ supporter: true })).posted.length, 0, 'never to a supporter');
  assert.equal((await runAsk({ use: { firstRunDay: '2000-01-01', usageDays: 3 } })).posted.length, 0, 'not before ten days of use');
});

test('the opened card carries the offer, monthly as the main button, and the way out', async () => {
  const d = await runAsk();
  const body = d.el('div');
  const foot = d.el('div');
  let closed = 0;
  const monthly = d.kinds.support.extra(body, foot, () => { closed++; });
  assert.equal(monthly.className, 'bm-go', 'returned, so the card puts it last');
  assert.deepEqual(foot.children.map((b) => b.className), ['bm-off', 'bm-quiet']);
  const perks = all(body).filter((n) => n.tag === 'li');
  assert.equal(perks.length, 4, 'four perks');
  assert.ok(all(perks[1]).some((n) => n.sprite), 'the Scintille perk wears the spark sprite, not a stand-in glyph');
  monthly.on.click();
  assert.match(d.opened[0], /membership/);
  assert.equal(closed, 1);
  foot.children[0].on.click();
  assert.equal(d.silenced, 1, 'the December appeal goes quiet too');
  assert.equal(closed, 2, 'and the card is gone: it was answered');
});

test('without the credits module the Scintille perk still reads, just without its sprite', async () => {
  const d = await runAsk({ credits: false });
  const body = d.el('div');
  d.kinds.support.extra(body, d.el('div'), () => {});
  assert.equal(all(body).filter((n) => n.tag === 'li').length, 4);
});
