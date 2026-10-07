// The capacity bar's file kinds. Three hosts compute them (the Windows and
// macOS helpers, and linux-index.js through disk-kinds.js), so the lists are
// compared here: a drift would split the same disk differently per platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const DK = require(join(ROOT, 'disk-kinds.js'));

test('extension and game-library rules', () => {
  assert.equal(DK.kindOf('clip.MP4', '/home/u/Videos'), 'video');
  assert.equal(DK.kindOf('photo.heic', 'C:\\Users\\u\\Pictures'), 'image');
  assert.equal(DK.kindOf('data.pak', 'D:\\SteamLibrary\\steamapps\\common\\Game'), 'game');
  assert.equal(DK.kindOf('setup.exe', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\X'), 'game',
    'a game library wins over the extension');
  assert.equal(DK.kindOf('.gitignore', '/r'), 'other', 'a leading dot is not an extension');
  assert.equal(DK.kindOf('archive.toolongext', '/r'), 'other');
  assert.equal(DK.kindOf('noext', '/r'), 'other');
  assert.deepEqual(Object.keys(DK.emptyKinds()), DK.KINDS);
});

function csLists() {
  const src = fs.readFileSync(join(REPO, 'helper', 'IndexHost.cs'), 'utf8');
  const kinds = [...src.matchAll(/Add\((\d), "([^"]+)"\);/g)].map((m) => [Number(m[1]), m[2]]);
  const names = /KindNames = \{([^}]+)\}/.exec(src)[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  const games = /GameLibraryNames =\s*\{([^}]+)\}/.exec(src)[1].split(',').map((s) => s.trim().replace(/"/g, '').toLowerCase());
  return { kinds, names, games };
}

function swiftLists() {
  const src = fs.readFileSync(join(REPO, 'helper-mac', 'Sources', 'xenon-helper', 'IndexHost.swift'), 'utf8');
  const kinds = [...src.matchAll(/\((\d), "([^"]+)"\),/g)].map((m) => [Number(m[1]), m[2]]);
  const names = /kindNames = \[([^\]]+)\]/.exec(src)[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  const games = /gameLibraryNames: Set<String> = \[([^\]]+)\]/.exec(src)[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  return { kinds, names, games };
}

for (const [host, read] of [['Windows helper', csLists], ['macOS helper', swiftLists]]) {
  test(`${host} uses the same kinds, extensions and game folders`, () => {
    const h = read();
    assert.deepEqual(h.names, DK.KINDS);
    const want = Object.entries(DK.EXT_LISTS).map(([kind, list]) => [DK.KINDS.indexOf(kind), list]);
    assert.deepEqual(h.kinds, want);
    assert.deepEqual(h.games, DK.GAME_LIBRARY_NAMES);
  });
}
