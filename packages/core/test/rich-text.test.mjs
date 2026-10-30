import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../src/rich-text.js');

// A real Store submission, CRLF and all.
const SPORTS = 'Track your favorite teams across 14 major sports leagues (NFL, NBA, MLB, NHL, NCAA, and top global soccer) in one personalized dashboard.\r\n\r\n* **Live Scores:** Auto-refreshing updates during active games.\r\n* **Schedules & Records:** See current standings and upcoming matchups at a glance.\r\n* **Native Themes:** Fully supports Xenon\'s Light, Dark, and Retro modes.';

// Minimal DOM, enough to see what render() builds.
function fakeDoc() {
  const node = (tag) => ({ tag, children: [], textContent: '', appendChild(c) { this.children.push(c); return c; } });
  return {
    createDocumentFragment: () => node('#frag'),
    createElement: (tag) => node(tag),
    createTextNode: (v) => ({ tag: '#text', v }),
  };
}
const html = (n) => {
  if (n.tag === '#text') return n.v.replace(/</g, '&lt;');
  if (n.tag === 'code') return '<code>' + n.textContent.replace(/</g, '&lt;') + '</code>';
  if (n.tag === 'br') return '<br>';
  const inner = n.children.map(html).join('');
  return n.tag === '#frag' ? inner : `<${n.tag}>${inner}</${n.tag}>`;
};
const render = (s) => html(rt.render(fakeDoc(), s));

test('a paragraph and a bullet list with bold labels', () => {
  assert.equal(render(SPORTS),
    '<p>Track your favorite teams across 14 major sports leagues (NFL, NBA, MLB, NHL, NCAA, and top global soccer) in one personalized dashboard.</p>'
    + '<ul><li><strong>Live Scores:</strong> Auto-refreshing updates during active games.</li>'
    + '<li><strong>Schedules & Records:</strong> See current standings and upcoming matchups at a glance.</li>'
    + '<li><strong>Native Themes:</strong> Fully supports Xenon\'s Light, Dark, and Retro modes.</li></ul>');
});

test('plain text drops the markers and keeps one block per line', () => {
  assert.equal(rt.plain(SPORTS),
    'Track your favorite teams across 14 major sports leagues (NFL, NBA, MLB, NHL, NCAA, and top global soccer) in one personalized dashboard.\n'
    + '• Live Scores: Auto-refreshing updates during active games.\n'
    + '• Schedules & Records: See current standings and upcoming matchups at a glance.\n'
    + '• Native Themes: Fully supports Xenon\'s Light, Dark, and Retro modes.');
});

test('a description without Markdown reads exactly as before', () => {
  assert.equal(render('A clean clock.'), '<p>A clean clock.</p>');
  assert.equal(rt.plain('A clean clock.'), 'A clean clock.');
  assert.equal(render('Line one\nline two'), '<p>Line one<br>line two</p>');
});

test('italic, code, headings, numbered lists and wrapped items', () => {
  assert.equal(render('# Setup\n1. Open *Settings*\n2. Paste `key_id`\n   then save'),
    '<p><strong>Setup</strong></p><ol><li>Open <em>Settings</em></li><li>Paste <code>key_id</code> then save</li></ol>');
  assert.equal(render('**bold with _italic_ inside**'), '<p><strong>bold with <em>italic</em> inside</strong></p>');
});

test('snake_case, lone asterisks and math are left alone', () => {
  assert.equal(rt.plain('use my_widget_id and 2 * 3 * 4'), 'use my_widget_id and 2 * 3 * 4');
  assert.equal(render('a * b'), '<p>a * b</p>');
  assert.equal(render('**not closed'), '<p>**not closed</p>');
});

test('backslash escapes keep the character', () => {
  assert.equal(rt.plain('\\*not italic\\* and \\# not a heading'), '*not italic* and # not a heading');
  assert.equal(render('\\- not a list'), '<p>- not a list</p>');
});

test('links show as their text, never as a link', () => {
  assert.equal(render('See [the docs](https://evil.example) now'), '<p>See the docs now</p>');
  assert.equal(render('[x](javascript:alert(1))'), '<p>x)</p>');
});

test('markup in the text stays text', () => {
  const out = render('<img src=x onerror=alert(1)> **<b>hi</b>**');
  assert.ok(!/<img|<b>/.test(out), out);
  assert.match(out, /&lt;img/);
});

test('bad input never throws', () => {
  for (const v of [null, undefined, 42, {}, '', '\n\n\n', '*'.repeat(5000), '_'.repeat(5000), '`'.repeat(999)]) {
    assert.doesNotThrow(() => { rt.plain(v); render(v); });
  }
  assert.equal(rt.plain(null), '');
});

test('hostile input stays fast', () => {
  const t0 = Date.now();
  rt.plain('**a '.repeat(400) + '_b '.repeat(400) + '*c'.repeat(400));
  assert.ok(Date.now() - t0 < 200, 'took ' + (Date.now() - t0) + 'ms');
});

test('the limit is one number', () => {
  assert.equal(rt.DESCRIPTION_MAX, 800);
});
