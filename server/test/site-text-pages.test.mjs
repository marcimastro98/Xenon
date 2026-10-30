// The text pages (download, help, privacy, the guides) on the home's system:
// one card (1px rule, 10px corners, no fill), notes as plain small text, file
// names in the text face, and the download cards drawn once in guide.css for
// every page that lists files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name) => readFileSync(join(root, 'docs', name), 'utf8');
const guide = read('guide.css');
const rule = (css, selector) => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};
const ownStyles = (html) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

test('a card is the home card: 1px rule, 10px corners, no fill', () => {
  const card = rule(guide, '.card');
  assert.match(card, /border: 1px solid var\(--rule\)/);
  assert.match(card, /border-radius: var\(--r-2\)/);
  assert.match(card, /background: none/);
  assert.doesNotMatch(guide, /\.card\.accent \{[^}]*background/);
});

test('the share, submit and status pages draw the same card', () => {
  for (const [file, sel] of [['get/index.html', '.card'], ['submit/index.html', '.card'], ['submit/index.html', '.status-link'], ['submit/status/index.html', '.st-card']]) {
    const r = rule(ownStyles(read(file)), sel);
    assert.match(r, /border: 1px solid var\(--rule\)/, `${file} ${sel}`);
    assert.match(r, /border-radius: var\(--r-2\)/, `${file} ${sel}`);
    assert.doesNotMatch(r, /background: var/, `${file} ${sel}`);
  }
  assert.match(rule(ownStyles(read('submit/status/index.html')), 'h1'), /margin: 0 0 16px/);
});

test('a note is plain small text, not a stripe on the side', () => {
  assert.doesNotMatch(rule(guide, '.note'), /border-left/);
});

test('the download cards live in guide.css, in the text face', () => {
  const pick = rule(guide, '.dl a.pick');
  assert.match(pick, /border: 1px solid var\(--rule\)/);
  assert.match(pick, /border-radius: var\(--r-2\)/);
  assert.doesNotMatch(rule(guide, '.dl .file'), /mono/);
  for (const page of ['download.html', 'mac.html', 'linux.html']) {
    assert.doesNotMatch(ownStyles(read(page)), /\.dl a\.pick \{[^}]*(border|background)|\.dl \.file \{/, `${page} keeps its own copy`);
  }
});

test('the visitor\'s own system is marked without !important', () => {
  const css = ownStyles(read('download.html')) + guide;
  assert.match(css, /\.dl a\.pick\.is-you \{/);
  assert.doesNotMatch(ownStyles(read('download.html')), /!important/);
});

test('each command sits under its own comment, so it never wraps into the next', () => {
  for (const page of ['download.html', 'linux.html']) {
    const pre = read(page).match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1];
    for (const line of pre.split('\n')) {
      assert.ok(!/\S\s+#/.test(line), `${page}: command and comment share a line: ${line}`);
    }
  }
  assert.match(read('download.html').match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1], /^# Windows, PowerShell\nGet-FileHash \.\\Xenon-Setup-x64\.exe /);
});
