// Text placed inside a PowerShell single-quoted string (server/ps-quote.js).
//
// PowerShell ends such a string on five characters: ' ‘ ’ ‚ ‛. Escaping only
// the ASCII one let a value carrying ’ close the string and run what followed,
// and an icon lookup took that value from a URL any page could load as an
// <img>. These tests pin the helper and keep the old one-character escape
// from coming back anywhere in the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { psEscape, psQuote } = require('../ps-quote.js');
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(SERVER_DIR, 'server.js'), 'utf8');

// What PowerShell's tokenizer does with a single-quoted literal: it ends on any
// of the five quote characters unless the next character is one of them too,
// in which case the pair is one literal character.
const QUOTES = new Set(["'", '\u2018', '\u2019', '\u201A', '\u201B']);
function psParseSingleQuoted(src) {
  assert.ok(QUOTES.has(src[0]), 'starts with a quote');
  let out = '';
  for (let i = 1; i < src.length; i++) {
    const c = src[i];
    if (QUOTES.has(c)) {
      if (QUOTES.has(src[i + 1])) { out += c; i++; continue; }
      return { value: out, rest: src.slice(i + 1) };
    }
    out += c;
  }
  return { value: out, rest: null };
}

test('every PowerShell quote character is doubled, so the value arrives intact', () => {
  for (const value of [
    "x');calc.exe;#",
    'x\u2019);calc.exe;#',          // the payload from the audit
    'x\u2018);calc.exe;#',
    'x\u201A);calc.exe;#',
    'x\u201B);calc.exe;#',
    "C:\\Users\\O'Brien\\Desktop\\Rock\u2019n\u2019Roll.exe",
    '',
  ]) {
    const { value: got, rest } = psParseSingleQuoted(psQuote(value));
    assert.equal(got, value, JSON.stringify(value));
    assert.equal(rest, '', 'nothing runs after the string');
  }
});

test('without the fix the same payload escapes the string', () => {
  // Proves the parser above models the attack: the old escape leaves code behind.
  const old = "'" + 'x\u2019);calc.exe;#'.replace(/'/g, "''") + "'";
  assert.notEqual(psParseSingleQuoted(old).rest, '');
});

test('a NUL never reaches PowerShell', () => {
  assert.equal(psEscape('a\0b'), 'ab');
  assert.equal(psEscape(null), '');
});

function serverSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'data' || name === 'js') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) serverSources(p, out);
    else if (name.endsWith('.js') && name !== 'ps-quote.js') out.push(p);
  }
  return out;
}

test('no server file escapes PowerShell quotes by hand any more', () => {
  const offenders = serverSources(SERVER_DIR).filter((f) => /replace\(\/'\/g,\s*"''"\)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'use psEscape/psQuote from ps-quote.js');
});

test('the icon lookup refuses network paths and is guarded against other sites', () => {
  const m = SERVER.match(/function isNetworkPath[\s\S]*?\n}\n/);
  assert.ok(m, 'isNetworkPath exists');
  const isNetworkPath = new Function(m[0] + '; return isNetworkPath;')();
  for (const p of ['\\\\evil\\s\\a.exe', '//evil/s/a.exe', '\\\\?\\UNC\\evil\\s\\a.exe', '\\\\.\\UNC\\evil\\s']) {
    assert.equal(isNetworkPath(p), true, p);
  }
  for (const p of ['C:\\Program Files\\App\\app.exe', '\\\\?\\C:\\Long\\app.exe', '/usr/bin/app', 'app.exe']) {
    assert.equal(isNetworkPath(p), false, p);
  }
  assert.match(SERVER, /appPath && !isNetworkPath\(appPath\)/);
  const list = SERVER.slice(SERVER.indexOf('const CSRF_MUTATION_PATHS = new Set(['), SERVER.indexOf(']);', SERVER.indexOf('const CSRF_MUTATION_PATHS = new Set([')));
  assert.ok(list.includes("'/deck/app-icon'"), 'on the cross-site list');
  const remote = readFileSync(join(SERVER_DIR, 'remote-access.js'), 'utf8');
  const reads = remote.slice(remote.indexOf('const GET_READ_EXCEPTIONS'), remote.indexOf(']);', remote.indexOf('const GET_READ_EXCEPTIONS')));
  assert.ok(reads.includes("'/deck/app-icon'"), 'still readable from a paired phone');
});
