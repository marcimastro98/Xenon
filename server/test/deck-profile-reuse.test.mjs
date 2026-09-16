import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Reusing a Deck profile on a second Deck, reported broken from a duplicated page.
//
// The path is: duplicate a page (which brings a fresh, independent Deck), then
// open the new Deck's profile menu and copy the profile across from the old one.
// What actually happened: the "From another Deck" section wasn't there at all, and
// the only thing on offer was a recovery list holding two obsolete versions —
// "The list has 2 items, but they are early obsolete versions … the one with the
// green bullet is the current one, but it is not visible on the second page."
//
// Two defects, feeding each other:
//
//  1. listOtherDeckProfiles dropped any source whose NAME this deck already had.
//     Having landed an obsolete "Nocturne Control" from the recovery list, the
//     current one was hidden BECAUSE the stale copy was sitting next to it. It was
//     the only candidate, so the whole section vanished.
//  2. Every copy kept the source's name verbatim, so the switcher grew five rows
//     reading "Nocturne Control" with nothing to tell them apart.

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');

function profile(name, keyCount) {
  return {
    name,
    root: { pages: [{ keys: Array.from({ length: keyCount }, (_, i) => ({ id: 'k' + i, kind: 'action', title: 't' + i })) }] },
  };
}

// listOtherDeckProfiles lives inside deck.js's IIFE, so it is lifted out and run
// against a store shaped like the report rather than asserted on as text.
function otherDeckProfiles(store, layout, instanceId) {
  const pick = (name) => {
    const at = DECK.indexOf('function ' + name + '(');
    assert.ok(at > 0, name + ' exists');
    return DECK.slice(at, DECK.indexOf('\n  }', at) + 4);
  };
  const scope = {
    window: { DeckModel: dm },
    readStore: () => store,
    getDashboardLayout: () => layout,
    durableConfig: (id) => dm.normalizeDeckConfig(store[id]),
  };
  const src = ['countProfileKeys', 'liveInstanceSet', 'isLiveInstance', 'listOtherDeckProfiles'].map(pick).join('\n');
  const build = new Function(...Object.keys(scope), src + '\nreturn listOtherDeckProfiles;');
  return build(...Object.values(scope))(instanceId);
}

test('the current profile is offered even when a stale namesake sits next to it', () => {
  const store = {
    deck: { profiles: [profile('Profile 1', 0), profile('Nocturne Control', 24)] },
    'deck~aa11': { profiles: [profile('Profile 1', 0), profile('Nocturne Control', 17)] },
  };
  const layout = { copies: [{ id: 'deck~aa11', widget: 'deck', page: 'page-2' }] };
  const offered = otherDeckProfiles(store, layout, 'deck~aa11');
  assert.equal(offered.length, 1, 'the section must not disappear because of a name clash');
  assert.equal(offered[0].name, 'Nocturne Control');
  assert.equal(offered[0].keys, 24, 'and it is the live one, not the 17-key copy already here');
});

test('two decks carrying the same name are both offered, with the count to tell them apart', () => {
  const store = {
    deck: { profiles: [profile('Nocturne Control', 24)] },
    'deck~aa11': { profiles: [profile('Nocturne Control', 17)] },
    'deck~bb22': { profiles: [profile('Nocturne Control', 8)] },
  };
  const layout = { copies: [{ id: 'deck~aa11' }, { id: 'deck~bb22' }] };
  const offered = otherDeckProfiles(store, layout, 'deck');
  assert.deepEqual(offered.map(o => o.keys).sort((a, b) => b - a), [17, 8],
    'both sources, not whichever key order put first');
  assert.ok(offered.every(o => typeof o.keys === 'number'), 'each row can say how much is in it');
});

test('a removed deck is still kept out of the live list', () => {
  // The dedupe went; the ghost gate did not. A stored config with no tile on the
  // dashboard belongs in the recovery list, never here.
  const store = {
    deck: { profiles: [profile('Work', 4)] },
    'deck~gone': { profiles: [profile('Old', 9)] },
  };
  const offered = otherDeckProfiles(store, { copies: [] }, 'deck');
  assert.deepEqual(offered, [], 'a deck no longer on the dashboard is not "another Deck"');
});

test('an empty placeholder profile is still not offered', () => {
  const store = {
    deck: { profiles: [profile('Work', 4)] },
    'deck~aa11': { profiles: [profile('Blank', 0)] },
  };
  const layout = { copies: [{ id: 'deck~aa11' }] };
  assert.deepEqual(otherDeckProfiles(store, layout, 'deck'), [], 'nothing to copy is nothing to offer');
});

test('copying the same profile twice does not make two rows that read the same', () => {
  const src = profile('Nocturne Control', 6);
  let target = dm.normalizeDeckConfig(null);
  target = dm.addProfileFromTemplate(target, src);
  target = dm.addProfileFromTemplate(target, src);
  target = dm.addProfileFromTemplate(target, src);
  const names = target.profiles.map(p => p.name);
  assert.equal(new Set(names).size, names.length, 'every profile in a deck is distinguishable by name');
  assert.ok(names.includes('Nocturne Control'), 'the first copy keeps the name it is recognised by');
  assert.ok(names.includes('Nocturne Control 2') && names.includes('Nocturne Control 3'));
});

test('the numbering is case-insensitive and leaves an unambiguous name alone', () => {
  let cfg = dm.normalizeDeckConfig({ profiles: [profile('work', 3)] });
  cfg = dm.addProfileFromTemplate(cfg, profile('Work', 5));
  assert.equal(cfg.profiles[cfg.profiles.length - 1].name, 'Work 2', '"work" and "Work" are the same row to a reader');
  cfg = dm.addProfileFromTemplate(cfg, profile('Streaming', 2));
  assert.equal(cfg.profiles[cfg.profiles.length - 1].name, 'Streaming', 'no clash, no suffix');
});

test('a 40-character name still gets numbered instead of spinning', () => {
  const long = 'x'.repeat(40);
  let cfg = dm.normalizeDeckConfig({ profiles: [profile(long, 3)] });
  cfg = dm.addProfileFromTemplate(cfg, profile(long, 3));
  const added = cfg.profiles[cfg.profiles.length - 1].name;
  assert.ok(added.length <= 40, 'names are clamped to 40');
  assert.notEqual(added.toLowerCase(), long, 'and it is not a second identical row');
  assert.match(added, / 2$/, 'the number survives; the stem is what gets trimmed');
});

test('the menu shows a key count wherever a name is ambiguous', () => {
  const at = DECK.indexOf('const nameUses = new Map();');
  assert.ok(at > 0, 'the profile list must know which names are shared');
  const block = DECK.slice(at, DECK.indexOf('pick.addEventListener', at));
  assert.match(block, /nameUses\.get\(String\(p\.name \|\| ''\)\.toLowerCase\(\)\) \|\| 0\) > 1/);
  assert.match(block, /deck-pmenu-count/, 'the count is what separates two namesakes');
  // …and the copy-from list carries one too, like the recovery list already did.
  const others = DECK.slice(DECK.indexOf('others.forEach((op) => {'));
  assert.match(others.slice(0, 600), /deck-pmenu-count/);
});
