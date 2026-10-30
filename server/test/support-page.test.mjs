// Settings → Support, rebuilt for v4.12.0: the ask (pitch, perks, supporter
// count, monthly/once links) beside a card for people who already support and
// the Discord card. These pin what the page needs to stay true and translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');

const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

const start = HTML.indexOf('settings-support-group" data-settings-cat="support"');
const PAGE = HTML.slice(start, HTML.indexOf('settings-ai-group', start));

/** Which languages define `key` (plain or quoted), tracking the namespace line by line. */
function langsDefining(key) {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const l = line.trimStart();
    if (l.startsWith(key + ':') || l.startsWith('"' + key + '":')) found.add(current);
  }
  return found;
}

test('the support page exists once and is found', () => {
  assert.ok(start > 0);
  assert.equal(HTML.split('settings-support-group"').length, 2);
});

test('every string on the support page is translated in all 11 languages', () => {
  const keys = [...PAGE.matchAll(/data-i18n="([a-z0-9_]+)"/g)].map(m => m[1]);
  assert.ok(keys.length >= 12, 'the page is translated, not hard-coded');
  for (const key of new Set(keys)) {
    const missing = LANGS.filter(l => !langsDefining(key).has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});

test('the strings the old page used are gone from every language', () => {
  for (const key of ['support_title', 'support_lead', 'support_coffee_btn', 'support_perks_title', 'support_perks_lead',
    'support_discord_title', 'support_discord_lead']) {
    assert.equal(langsDefining(key).size, 0, `${key} is dead and should not linger`);
    assert.doesNotMatch(HTML, new RegExp(`data-i18n="${key}"`));
  }
});

test('the new strings carry no em dash (plain-language rule)', () => {
  const block = I18N.slice(I18N.indexOf('support_have_code_lead'));
  for (const m of block.matchAll(/support_(?:have_code_lead|code_btn|ask_lead|plan_[a-z_]+): "([^"]*)"/g)) {
    assert.doesNotMatch(m[1], /—/, m[1]);
  }
});

// Monthly and yearly both land on the membership page (the hub's default plan);
// the yearly tile carries its own source label so the hub counts it apart.
test('the three price tiles go through the hub counter, monthly first and the only filled one', () => {
  const links = [...PAGE.matchAll(/href="(https:\/\/xenon-supporter-hub[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(links, [
    'https://xenon-supporter-hub.xenonedge.workers.dev/go/support?s=settings',
    'https://xenon-supporter-hub.xenonedge.workers.dev/go/support?s=settings-year',
    'https://xenon-supporter-hub.xenonedge.workers.dev/go/support?s=settings&amp;p=once',
  ]);
  // The hub folds an unknown label into 'other' (download-redirect.js normalizeSource).
  assert.match('settings-year', /^[a-z0-9][a-z0-9_-]{0,23}$/);
  const tiles = [...PAGE.matchAll(/<a class="(support-plan[^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(tiles, ['support-plan is-main', 'support-plan', 'support-plan']);
  for (const m of PAGE.matchAll(/<a [^>]*target="_blank"[^>]*>/g)) {
    assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
  }
});

test('the supporter count box keeps the id and shape support-goal.js fills', () => {
  assert.match(PAGE, /<div class="support-goal" id="settings-support-goal" hidden>/);
  assert.match(PAGE, /class="support-goal-line"/);
  assert.match(PAGE, /<progress class="support-goal-bar"/);
});

test('no emoji used as an icon on the page', () => {
  assert.doesNotMatch(PAGE, /\p{Extended_Pictographic}/u);
});

// js/support-card.js builds its own `.support-card`; the page must not borrow
// that class (or the old two-column ones) and pick up the other's rules.
test('the page uses its own classes, not the support card component\'s', () => {
  assert.doesNotMatch(PAGE, /class="[^"]*\bsupport-(?:card|main|side|cta)\b/);
});

// "Enter your code" must land on the supporter box, in the sdk pane, with the
// cursor in the field when it is showing.
test('openSupporterCode opens the sdk pane and focuses the code field', () => {
  const at = SETTINGS.indexOf('function openSupporterCode()');
  assert.ok(at > 0);
  const src = SETTINGS.slice(at, SETTINGS.indexOf('window.openSupporterCode', at));
  const calls = [];
  const field = {
    hidden: false,
    focus: (o) => calls.push(['focus', o]),
    closest: (sel) => (sel === '.settings-subcard' ? { scrollIntoView: (o) => calls.push(['scroll', o]) } : null),
  };
  const ctx = { $: (id) => (id === 'settings-supporter-code' ? field : null), settingsSetCategory: (c) => calls.push(['cat', c]) };
  vm.runInNewContext(src + '; openSupporterCode();', ctx);
  assert.deepEqual(calls.map(c => c[0]), ['cat', 'scroll', 'focus']);
  assert.equal(calls[0][1], 'sdk');
  assert.equal(calls[2][1].preventScroll, true, 'the scroll is the smooth one, not the focus jump');

  // A saved code hides the field: scroll there, never focus a hidden input.
  calls.length = 0;
  field.hidden = true;
  vm.runInNewContext(src + '; openSupporterCode();', ctx);
  assert.deepEqual(calls.map(c => c[0]), ['cat', 'scroll']);
});

test('the supporter box the button points at is in the sdk pane', () => {
  const field = HTML.indexOf('id="settings-supporter-code"');
  const before = HTML.slice(0, field);
  const cat = [...before.matchAll(/data-settings-cat="([a-z-]+)"/g)].at(-1)[1];
  assert.equal(cat, 'sdk');
});
