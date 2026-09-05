// Keys from a Deck that is no longer on the dashboard.
//
// Three rules had grown up around a stored deck config whose tile is gone, and
// together they made a trap:
//
//   • pruneOrphanEmptyConfigs deletes only EMPTY orphans, explicitly because
//     "data is surfaced, not silently deleted";
//   • isLiveInstance hides every orphan's profiles from the profile menu and the
//     share picker, so a removed deck leaves no ghosts;
//   • and the profile menu offered exactly one thing to do about them — a 🗑
//     button that throws them away.
//
// So keys the app had promised to keep were kept, hidden, and offered only for
// deletion. Reported after a dashboard came back as the factory default: the deck
// tiles went with it, and every key on them became unreachable while still
// sitting in deck.json, with several same-named empty profiles in the list where
// the real one used to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DeckPanel/DeckPanel.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

function fn(name) {
  const start = DECK.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' exists');
  return DECK.slice(start, DECK.indexOf('\n  }', start));
}

test('the profiles on a removed deck can be listed again', () => {
  const body = fn('listOrphanProfiles');
  assert.match(body, /for \(const id of listOrphanInstances\(\)\)/,
    'it reads exactly the set the 🗑 button would delete');
  assert.match(body, /if \(keys > 0\)/, 'an empty placeholder is not worth offering');
  assert.match(body, /keys \}\)/, 'and each row carries how much is in it');
});

// listOtherDeckProfiles hides a source whose NAME this deck already has. Applying
// that here would hide the recovered profile behind the empty namesake that
// replaced it — which is the exact state someone reaches this list in.
test('a recovered profile is not hidden behind an empty namesake', () => {
  const body = fn('listOrphanProfiles');
  assert.doesNotMatch(body, /mine\.has|seen\.has/,
    'no name dedupe: two same-named profiles are the case this exists for');
  const other = fn('listOtherDeckProfiles');
  assert.match(other, /mine\.has\(key\)/, 'the live-deck list still dedupes, as it should');
});

test('the menu offers them, with the count that tells two namesakes apart', () => {
  const menu = DECK.slice(DECK.indexOf('const lost = listOrphanProfiles();'));
  const block = menu.slice(0, menu.indexOf('// Clean up leftovers'));
  assert.match(block, /deck_profiles_lost/, 'the section is named');
  assert.match(block, /copyDeckProfileInto\(instanceId, op\.instanceId, op\.profileId\)/,
    'tapping one copies it in — the same act as copying from a live deck');
  assert.match(block, /deck-pmenu-count/, 'the key count is on the row');
  assert.match(CSS, /\.deck-pmenu-count \{/, 'and the count has a style');
});

// Recovering work is not editing the layout. Gating this on edit mode would mean
// the person looking for a profile they lost has to guess that the pencil is what
// reveals it.
test('recovery is not hidden behind edit mode, unlike the delete button', () => {
  const lostAt = DECK.indexOf('const lost = listOrphanProfiles();');
  const purgeAt = DECK.indexOf('const orphans = listOrphanInstances();', lostAt);
  const between = DECK.slice(lostAt, purgeAt);
  assert.doesNotMatch(between.slice(0, between.indexOf('menu.appendChild(llist);')), /state\.editing/,
    'the recovery list is offered outside edit mode');
  assert.match(DECK.slice(purgeAt - 200, purgeAt), /if \(state\.editing\) \{/,
    'the delete button stays behind edit mode');
  assert.ok(lostAt < purgeAt, 'and recovery is offered before deletion, not after it');
});

// "Leftovers" is true of the configs and false of their contents, and this button
// is the only way those contents can be lost for good.
test('the delete confirmation counts the keys it is about to destroy', () => {
  const body = fn('orphanKeyCount');
  assert.match(body, /reduce\(\(n, p\) => n \+ p\.keys, 0\)/, 'it counts the keys, not the profiles');
  const purge = DECK.slice(DECK.indexOf('const keys = orphanKeyCount();'));
  const block = purge.slice(0, purge.indexOf('purgeOrphanInstances();'));
  assert.match(block, /deck_purge_orphans_confirm_keys/, 'the wording names the number');
  assert.match(block, /\.replace\('#n', String\(keys\)\)/, 'with the real count');
  // Zero keys is a genuinely harmless cleanup and keeps the old, calmer sentence.
  assert.match(block, /: tr\('deck_purge_orphans_confirm'/, 'nothing to lose → nothing alarming said');
});

test('both strings exist in every language the app ships', () => {
  for (const key of ['deck_profiles_lost', 'deck_purge_orphans_confirm_keys']) {
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
  for (const m of I18N.matchAll(/deck_purge_orphans_confirm_keys"?:\s*("(?:[^"\\]|\\.)*")/g)) {
    assert.match(JSON.parse(m[1]), /#n/, 'a translation without #n loses the count');
  }
});
