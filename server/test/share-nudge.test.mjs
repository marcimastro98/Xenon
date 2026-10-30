// The one-time "show off your setup" invitation.
//
// The share card has existed since 4.10 behind a button in Settings, where the
// people who would post it never found it. One photo of a desk with Xenon on it
// did ten times the reach of every post about the product, and the person who
// posted it was not the author: users are the distribution. This invites them,
// once, under the same rules as the supporter ask — and those rules are what
// keep an invitation from becoming a nag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };

const CARD = readFileSync(new URL('../js/share-nudge.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

test('the gate is fourteen days AND five separate days of use', () => {
  assert.match(CARD, /const DAYS_SINCE_FIRST_RUN = 14;/);
  assert.match(CARD, /const DISTINCT_DAYS_USED = 5;/);
  const fn = CARD.slice(CARD.indexOf('async function maybeShow()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /daysSince\(use\.firstRunDay\) < DAYS_SINCE_FIRST_RUN\) return;/);
  assert.match(body, /use\.usageDays < DISTINCT_DAYS_USED\) return;/);
  assert.match(body, /if \(!use\) return;/, 'and nothing is decided before the stored answer is known');
});

// Same home as the supporter ask's flag, for the same reason: a browser set to
// clear its site data would otherwise bring the card back every few weeks.
test('the dismissal lives in hub settings, never in localStorage', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function rememberShareNudgeSeen()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /shareNudgeSeen: true/);
  assert.doesNotMatch(body, /localStorage/);
  assert.match(SETTINGS, /function shareNudgeDismissed\(\)[\s\S]{0,160}hubSettings\.shareNudgeSeen === true/);
  assert.match(SETTINGS, /shareNudgeSeen: value\.shareNudgeSeen === true,/, 'the client normaliser knows the key');
  assert.match(SETTINGS, /shareNudgeDismissed,\n\s*rememberShareNudge: rememberShareNudgeSeen,/, 'and it is on the startup-cards namespace');
  // The comment at the top of the card says "never in localStorage"; the code must not use it.
  assert.doesNotMatch(CARD.replace(/\/\/.*$/gm, ''), /localStorage/);
});

test('the server stores it, and a stale client save cannot un-dismiss it', () => {
  assert.match(SERVER, /shareNudgeSeen: false,/, 'a default on disk');
  assert.match(SERVER, /shareNudgeSeen: source\.shareNudgeSeen === true,/, 'normalised like the ask');
  const post = SERVER.slice(SERVER.indexOf("reqPath === '/settings' && req.method === 'POST'"));
  const block = post.slice(0, post.indexOf('} else if (reqPath'));
  assert.match(block, /if \(prev\.shareNudgeSeen === true\) incoming\.shareNudgeSeen = true;/);
});

// Filing a letter interrupts nothing; Bit's note about it waits through a voice
// session, the lock screen, a game or a scene (bit-mail-core.js quiet()).
test("it is filed as one letter in Bit's mail, never a card on screen", () => {
  assert.doesNotMatch(CARD, /document\.body\.appendChild|getElementById\('share-nudge'\)/, 'no corner card any more');
  const gate = CARD.slice(CARD.indexOf('async function maybeShow()'));
  const body = gate.slice(0, gate.indexOf('\n  }'));
  assert.match(body, /window\.BitMail\.post\(\{\s*id: 'share:setup',\s*kind: 'share'/);
  assert.match(body, /remember\(\);/, 'remembered as it is filed: once means once, read or not');
  assert.match(body, /if \(!window\.ShareCard/, 'and never invites without the composer');
  assert.match(CARD, /window\.BitMail\.register\('share', drawLetter\)/);
  const draw = CARD.slice(CARD.indexOf('function drawLetter('));
  assert.match(draw.slice(0, draw.indexOf('\n  }')), /ShareCard\.open\(\{ source: 'setup' \}\)/,
    'its button opens the share card in Settings, not a second composer');
});

test('the letter is loaded, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-card\.js"><\/script>\n<script src="js\/share-nudge\.js"><\/script>/,
    'loaded right after the supporter ask, which it defers to');
  for (const key of ['share_nudge_title', 'share_nudge_text', 'share_nudge_go']) {
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

// Plain speech, same rule as the ask: no em dashes anywhere on the card.
test('the card speaks plainly, with no em dashes', () => {
  let checked = 0;
  for (const m of I18N.matchAll(/share_nudge_[a-z]+"?:\s*("(?:[^"\\]|\\.)*")/g)) {
    checked++;
    assert.ok(!JSON.parse(m[1]).includes('—'), 'em dash in: ' + m[1].slice(0, 50));
  }
  assert.equal(checked, 33, 'three strings in eleven languages');
});
