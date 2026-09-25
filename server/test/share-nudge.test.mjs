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

test('it never interrupts a voice session, the lock screen, a game, a scene, or another card', () => {
  const fn = CARD.slice(CARD.indexOf('function busyRightNow()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  for (const cls of ['lock-screen-active', 'ai-voice-mode', 'ai-listening', 'game-mode',
    'ambient-scene-open', 'ambient-canvas-open']) {
    assert.match(body, new RegExp(cls), `${cls} holds the card back`);
  }
  assert.match(body, /catch \{ return true; \}/, 'if it cannot tell, it does not interrupt');
  const show = CARD.slice(CARD.indexOf('setTimeout(() => {', CARD.indexOf('async function maybeShow()')));
  assert.match(show.slice(0, 400), /if \(busyRightNow\(\)\) return;/, 're-checked at the last moment');
  assert.match(show.slice(0, 400), /if \(anotherCardUp\(\)\) return;/, 'never two cards in the corner');
  assert.match(CARD, /getElementById\('support-ask'\) \|\| document\.getElementById\('discord-invite'\)/);
  // It is the last of the three to arrive on a boot where more than one is due.
  assert.match(CARD, /const SHOW_AFTER_MS = 7000;/);
});

// Every way off the card is final: the button, "not now", and the ×. Once per
// install means once, whichever way it ends.
test('every exit remembers, and the button opens the composer that already exists', () => {
  for (const anchor of ["go.addEventListener", "later.addEventListener", "close.addEventListener"]) {
    const fn = CARD.slice(CARD.indexOf(anchor));
    const body = fn.slice(0, fn.indexOf('});') + 3);
    assert.match(body, /remember\(\);/, anchor + ' remembers');
  }
  const go = CARD.slice(CARD.indexOf("go.addEventListener"));
  assert.match(go.slice(0, go.indexOf('\n    });')), /ShareCard\.open\(\{ source: 'setup' \}\)/,
    'it opens the share card in Settings, not a second composer');
  const gate = CARD.slice(CARD.indexOf('async function maybeShow()'));
  assert.match(gate.slice(0, gate.indexOf('\n  }')), /if \(!window\.ShareCard/, 'and never invites without it');
});

test('the card is loaded, styled, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-card\.js"><\/script>\n<script src="js\/share-nudge\.js"><\/script>/,
    'loaded right after the supporter ask, which it defers to');
  assert.match(HTML, /components\/ShareNudge\/ShareNudge\.css/);
  const css = readFileSync(new URL('../components/ShareNudge/ShareNudge.css', import.meta.url), 'utf8');
  assert.match(css, /\.share-nudge \.share-nudge-logo \{ background: var\(--accent/, 'the disc is the theme accent, not Discord blue');
  for (const key of ['share_nudge_title', 'share_nudge_text', 'share_nudge_go', 'share_nudge_later']) {
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
  assert.equal(checked, 44, 'four strings in eleven languages');
});
