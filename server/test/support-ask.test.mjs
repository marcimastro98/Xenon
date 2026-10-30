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
  // The ask itself is a letter now: nothing goes on screen, and Bit's note,
  // which does, waits through the same moments (bit-mail-core.js quiet()).
  assert.doesNotMatch(CARD, /document\.body\.appendChild|getElementById\('support-ask'\)/, 'no corner card any more');
  assert.match(CARD, /window\.XenonSupportAsk = \{[^}]*busyRightNow/, 'kept for the December appeal');
});

// Three objects you get, each with its own glyph. The same three facts in one
// sentence were skimmed past, which is what made the card read as small print.
test('the perks are a list of things, not a sentence about them', () => {
  const fn = CARD.slice(CARD.indexOf("perks.className = 'bitmail-perks'"));
  const body = fn.slice(0, fn.indexOf('\n    });'));
  for (const key of ['support_perk_themes', 'support_perk_discord', 'support_perk_name']) {
    assert.match(body, new RegExp(key), key + ' is its own row');
  }
  assert.match(body, /createElement\('li'\)/, 'rendered as list items');
  assert.match(body, /bitmail-perk-icon/, 'each with its own glyph');
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
  for (const m of I18N.matchAll(/support_(?:ask|perk|thanks)_[a-z]+"?:\s*("(?:[^"\\]|\\.)*")/g)) {
    checked++;
    assert.ok(!JSON.parse(m[1]).includes('\u2014'), 'em dash in: ' + m[1].slice(0, 50));
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
  const css = readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8');
  // The only filled thing on the card. Two equal buttons is the shape of a card
  // that has not decided what it is asking for.
  assert.match(css, /\.support-ask \.support-ask-monthly \{[\s\S]*?background: linear-gradient\([^)]*var\(--sup-pink-deep\)/,
    'monthly is the filled button');
  assert.match(css, /\.support-ask \.support-ask-once \{[\s\S]*?background: none;/,
    'and the one-off is not');
});

// ── The heart sits in the middle of the thing holding it ───────────────────
// Two separate ways to be a pixel off, both of which were visible on the first
// build and neither of which is obvious from reading the CSS.
test('the heart is centred in its disc and in its tile', () => {
  const css = readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8');

  // 1. The glyph's own ink is not centred in a 0 0 24 24 box: it runs from
  //    y 3.49 to y 21, so its middle is 12.246. The viewBox is shifted down by
  //    that quarter unit to put the shape's middle on the box's middle.
  assert.match(CARD, /const HEART = '<svg viewBox="0 0\.25 24 24"/,
    'the heart viewBox is offset to centre the ink, not the box');

  // 2. A holder centres by sharing out what is left over, so an odd remainder
  //    lands the glyph half a pixel off to one side. Both holders must leave an
  //    even gap.
  const size = (selector) => {
    const rule = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(rule, `no rule for ${selector}`);
    const w = rule[1].match(/width:\s*(\d+)px/);
    assert.ok(w, `${selector} has no pixel width`);
    return Number(w[1]);
  };
  for (const [holder, glyph] of [
    ['.support-ask .support-ask-heart', '.support-ask .support-ask-heart svg'],
    ['.support-ask .support-ask-logo', '.support-ask .support-ask-logo svg'],
  ]) {
    const gap = size(holder) - size(glyph);
    assert.equal(gap % 2, 0,
      `${holder} leaves ${gap}px around the glyph, so it sits ${gap / 2}px from one side and cannot be centred`);
  }
});

// ── The palette ────────────────────────────────────────────────────────────
// This card is the one surface in Xenon that does not follow the theme accent,
// and the reason is written at the top of its stylesheet: on a lime accent it
// read as a system notice, and on a pink one the ask vanished into its own
// header. If someone ever "fixes" that by wiring --accent back in, the card
// silently goes back to being a themed panel — so the absence is a test.
test('the card carries its own pink, on every theme', () => {
  const css = readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');   // comments explain the choice; they are not it
  assert.ok(!/--accent/.test(rules), 'nothing on this card is painted from the theme accent');
  assert.match(rules, /--sup-pink:\s*255,\s*45,\s*138/, 'the neon pink is declared once, on the card');
  assert.match(rules, /--sup-red:\s*#ff2b3d/, 'and the heart has its own red');
});

// A red heart drawn straight onto the pink is 1.06:1 against it: the shape is
// not there at all. It gets a white disc, and the label gets the deep end of
// the gradient under it so white text clears AA at 12.5px.
test('the ask is readable: white on the pink, and the heart on white', () => {
  const css = readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8');
  assert.match(css, /\.support-ask \.support-ask-heart \{[\s\S]*?background: #fff;/,
    'the heart rides on a white disc');
  assert.match(css, /\.support-ask \.support-ask-heart svg \{[^}]*color: var\(--sup-red\)/,
    'and the heart itself is the red');

  const lum = (hex) => {
    const n = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const deep = css.match(/--sup-pink-deep:\s*(\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(deep, 'the deep end of the gradient is declared');
  const hex = '#' + deep.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  assert.ok(contrast(hex, '#ffffff') >= 4.5,
    `white on ${hex} is ${contrast(hex, '#ffffff').toFixed(2)}:1, below AA`);
  const red = css.match(/--sup-red:\s*(#[0-9a-f]{6})/i);
  assert.ok(red && contrast(red[1], '#ffffff') >= 3,
    'the heart is visible on its white disc');
});

test('the card is loaded, styled, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-card\.js"><\/script>/);
  assert.match(HTML, /components\/SupportAsk\/SupportAsk\.css/);
  for (const key of ['support_ask_title', 'support_ask_text',
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

// ── The letter, run ────────────────────────────────────────────────────────
// The gate passing files ONE letter in Bit's mail and remembers the ask at
// once; opening the letter draws the offer. Run against DOM stubs.
async function runAsk({ credits = true, dismissed = false, supporter = false, use = { firstRunDay: '2000-01-01', usageDays: 40 } } = {}) {
  const el = (tag) => ({
    tag, className: '', type: '', textContent: '', innerHTML: '', children: [], on: {},
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { this.on[t] = fn; }, setAttribute() {},
  });
  const posted = [];
  const renderers = {};
  const opened = [];
  let remembered = 0;
  let silenced = 0;
  const window = {
    BitMail: { post: (l) => { posted.push(l); return true; }, register: (k, fn) => { renderers[k] = fn; } },
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
  return { posted, renderers, opened, get remembered() { return remembered; }, get silenced() { return silenced; } };
}
const all = (n) => (n ? [n, ...(n.children || []).flatMap(all)] : []);

test('the ask is filed once as a letter, and remembered as it is filed', async () => {
  const d = await runAsk();
  assert.equal(d.posted.length, 1);
  assert.equal(d.posted[0].id, 'support:ask');
  assert.equal(d.posted[0].kind, 'support');
  assert.equal(d.remembered, 1, 'once means once, read or not');
  assert.equal((await runAsk({ dismissed: true })).posted.length, 0, 'never twice');
  assert.equal((await runAsk({ supporter: true })).posted.length, 0, 'never to a supporter');
  assert.equal((await runAsk({ use: { firstRunDay: '2000-01-01', usageDays: 3 } })).posted.length, 0, 'not before ten days of use');
});

test('the opened letter carries the offer, monthly first, and the way out', async () => {
  const d = await runAsk();
  const node = { children: [], append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; } };
  const ctx = { closed: 0, removed: 0, close() { this.closed++; }, remove() { this.removed++; } };
  d.renderers.support(d.posted[0], node, ctx);
  const buttons = all(node).filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.className), ['bitmail-btn is-main', 'bitmail-btn', 'bitmail-link']);
  const perks = all(node).filter((n) => n.tag === 'li');
  assert.equal(perks.length, 4, 'four perks');
  assert.ok(all(perks[1]).some((n) => n.sprite), 'the Scintille perk wears the spark sprite, not a stand-in glyph');
  buttons[0].on.click();
  assert.match(d.opened[0], /membership/);
  assert.equal(ctx.closed, 1);
  buttons[2].on.click();
  assert.equal(d.silenced, 1, 'the December appeal goes quiet too');
  assert.equal(ctx.removed, 1, 'and the letter is gone: it was answered');
});

test('without the credits module the Scintille perk still reads, just without its sprite', async () => {
  const d = await runAsk({ credits: false });
  const node = { children: [], append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; } };
  d.renderers.support(d.posted[0], node, { close() {}, remove() {} });
  assert.equal(all(node).filter((n) => n.tag === 'li').length, 4);
});
