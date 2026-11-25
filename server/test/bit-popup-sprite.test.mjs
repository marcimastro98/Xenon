// The person's own Bit in the Windows Vitals popup (server/bit/sprite.js -> vitals-nag.ps1):
// what the server sends reads as the script's checks want it, and the script keeps its classic
// Bit for anything else. Every seed here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../bit/model.js');
const { spriteFor, CLIPS } = require('../bit/sprite.js');

const NOW = new Date(2026, 11, 3, 12);
const egg = Model.normalize({ eggAt: '2026-01-01T00:00:00.000Z' });
const born = Model.hatched(egg, { seed: '0123456789abcdef', number: 7, born: NOW.toISOString(), sig: 'made-up' }, NOW).model;
const SCRIPT = readFileSync(new URL('../vitals-nag.ps1', import.meta.url), 'utf8');
// The script's own checks, read from it so the two cannot drift.
const PALETTE = new RegExp(SCRIPT.match(/\$Palette -cmatch '([^']+)'/)[1]);
const CELLS = new RegExp(SCRIPT.match(/\$Cells -cmatch '([^']+)'/)[1]);

test('a hatched Bit becomes colours and rows the popup accepts, for each mood it draws', () => {
  for (const mood of Object.keys(CLIPS)) {
    const s = spriteFor({ ...born, worn: ['scarf'] }, mood);
    assert.ok(s, mood);
    assert.match(s.palette, PALETTE);
    assert.match(s.rows, CELLS);
    const rows = s.rows.split('|');
    assert.ok(rows.every((r) => r.length === rows[0].length), 'one width');
    const colours = s.palette.split(',').length;
    assert.ok([...s.rows.replace(/[.|]/g, '')].every((c) => c.charCodeAt(0) - 65 < colours), 'every letter is a colour');
  }
});

test('the classic Bit stays for an egg, the classic choice, the ghost and nothing at all', () => {
  assert.equal(spriteFor(egg, 'angry'), null);
  assert.equal(spriteFor({ ...born, prefs: { ...born.prefs, classic: true } }, 'angry'), null);
  assert.equal(spriteFor(born, 'ghost'), null);
  assert.equal(spriteFor(null, 'angry'), null);
  assert.equal(spriteFor(born, 'nope'), null);
});

test('the script: the ghost keeps its drawing, and no parameter shares a name with a variable', () => {
  assert.match(SCRIPT, /\$Mood -ne 'ghost' -and \$Palette -cmatch/);
  // PowerShell names ignore case: a typed parameter and a variable spelt otherwise are one,
  // and the variable is turned into the parameter's type (the -Font and $rows lesson).
  const code = SCRIPT.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
  const block = code.slice(code.indexOf('param('), code.indexOf(')\n', code.indexOf('param('))).replace(/\s#.*$/gm, '');
  const params = [...block.matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1]);
  for (const name of params) {
    const other = [...code.matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1]).filter((v) => v.toLowerCase() === name.toLowerCase() && v !== name);
    assert.deepEqual(other, [], name);
  }
});
