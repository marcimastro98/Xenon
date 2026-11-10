// The pictures of the first question: a new install shows them before anything else, so one
// missing is a hole in the first screen, and they ship in every update zip.
// Made by tools/first-run-shots/shoot.mjs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';
import { DASHBOARDS, DESK, DESK_PLAIN, WIDGETS } from '../../tools/first-run-shots/shoot.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(SERVER, 'assets', 'first-run');
const MAX_BYTES = 48 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

const names = [
  ...DASHBOARDS.map(([name]) => name),
  DESK[0],
  DESK_PLAIN[0],
  ...WIDGETS.map(([name]) => `widget-${name}`),
];

test('every picture the tool makes is there, and nothing else', () => {
  const files = readdirSync(DIR).sort();
  assert.deepEqual(files, names.map((name) => `${name}.webp`).sort());
});

test('each picture is a WebP and stays light', () => {
  let total = 0;
  for (const name of names) {
    const file = path.join(DIR, `${name}.webp`);
    const head = readFileSync(file).subarray(0, 12);
    assert.equal(head.toString('latin1', 0, 4), 'RIFF', name);
    assert.equal(head.toString('latin1', 8, 12), 'WEBP', name);
    const { size } = statSync(file);
    assert.ok(size <= MAX_BYTES, `${name} is ${size} bytes`);
    total += size;
  }
  assert.ok(total <= MAX_TOTAL_BYTES, `all together ${total} bytes`);
});

test('the question asks only for pictures that exist', () => {
  const code = readFileSync(path.join(SERVER, 'js', 'usage-ask-picture.js'), 'utf8');
  for (const shape of ['tall', 'edge', 'wide']) {
    assert.match(code, new RegExp(`'${shape}'`), shape);
    assert.ok(names.includes(`dash-${shape}`), shape);
  }
  assert.ok(names.includes('dash-phone'));
  const starters = code.match(/STARTERS = Object\.freeze\(\[([^\]]+)\]/)[1].match(/[a-z]+/g);
  for (const name of starters) assert.ok(names.includes(`widget-${name}`), name);
  for (const [, name] of code.matchAll(/pic\('([a-z-]+)'/g)) assert.ok(names.includes(name), name);
});

// Seen 7 Nov 2026: decoded late, the pictures popped in over empty screens as the splash lifted.
test('a picture comes with its screen: decoded with the frame, and faded in if it arrives late', () => {
  const { document } = makeDom();
  const made = [];
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'img') made.push(node);
    return node;
  };
  const window = {};
  vm.runInNewContext(readFileSync(path.join(SERVER, 'js', 'usage-ask-picture.js'), 'utf8'), { document, window });
  window.UsageAskPicture.create({ onTap() {}, nameOf: () => '', tapLabel: () => '' });
  assert.ok(made.length > 0);
  for (const img of made) {
    assert.equal(img.decoding, 'sync');
    assert.equal(img.classList.contains('is-in'), false);
    img._handlers.load.forEach((run) => run());
    assert.equal(img.classList.contains('is-in'), true);
  }
  const css = readFileSync(path.join(SERVER, 'components', 'UsageAsk', 'UsageAsk.css'), 'utf8');
  assert.match(css, /.ua-pic {[^}]*opacity: 0;[^}]*transition: opacity/);
  assert.match(css, /.ua-pic.is-in { opacity: 1; }/);
  assert.ok(css.indexOf('.ua-pic.is-in') < css.indexOf('.ua-layer > .ua-w {'), 'a widget picture still waits for its turn');
});

test('the picture starts from the same widgets the plan places', () => {
  const plan = readFileSync(path.join(SERVER, 'js', 'usage-ask-plan.js'), 'utf8');
  const picture = readFileSync(path.join(SERVER, 'js', 'usage-ask-picture.js'), 'utf8');
  const list = (code) => code.match(/STARTERS = Object\.freeze\(\[([^\]]+)\]/)[1].match(/[a-z]+/g);
  assert.deepEqual(list(picture), list(plan));
});
