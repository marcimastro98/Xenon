// `tools/restructure/ui-shape/ui-shape-check.mjs` walks one window of the app on a throwaway copy and writes
// down the shape of the page after every step, so a function that builds a window can be
// cut into scripts and shown to build the same window. These tests hold the parts that
// need no browser: how an element is written as lines, what a plan must say, how a
// request is written without what it carries, and how the first difference is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGE_NAME, initScript, overEvents, shapeLines } from '../../tools/restructure/ui-shape/ui-shape-page.mjs';
import { bodyShape, firstDifference, laidOver, planProblems, replacerOf, requestLine, shapeOfValue } from '../../tools/restructure/ui-shape/ui-shape-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const text = (value) => ({ nodeType: 3, nodeValue: value });
const element = (tagName, attributes = {}, childNodes = [], more = {}) => ({
  nodeType: 1, tagName, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })), childNodes, ...more,
});

const PLAN = { name: 'sample-window', page: '/', width: 800, height: 600, roots: ['#window'], steps: [{ say: 'the window opens', do: 'click', on: '#open' }] };

test('an element is written with its tag, id, classes, attributes by name, value and listeners; its texts and elements one step deeper', () => {
  const tree = element('DIV', { class: 'box  wide', id: 'window', 'data-kind': 'sample', 'aria-label': 'A  window' }, [
    text('  Hello\n  there '),
    text('   '),
    element('INPUT', { type: 'checkbox' }, [], { value: 'on', checked: true, disabled: true }),
    { nodeType: 8, nodeValue: 'a comment is not shape' },
    element('BUTTON', { class: 'go' }, [text('Go')]),
  ]);
  const listeners = (node) => (node.tagName === 'BUTTON' ? 'click:1' : '');
  assert.deepEqual(shapeLines(tree, { listeners }), [
    'div#window.box.wide [aria-label="A window"] [data-kind="sample"]',
    '  "Hello there"',
    '  input [type="checkbox"] value="on" checked disabled',
    '  button.go {click:1}',
    '    "Go"',
  ]);
});

test('an element the plan skips is one line, with nothing of what is under it', () => {
  const tree = element('UL', {}, [element('LI', { class: 'clock' }, [text('12:34')]), element('LI', {}, [text('kept')])]);
  assert.deepEqual(shapeLines(tree, { skip: (node) => node.tagName === 'LI' && node.attributes.length > 0, depth: 1 }), ['  ul', '    li.clock …', '    li', '      "kept"']);
});

test('the script given to the page carries the reader as code and builds no code from text', () => {
  const script = initScript();
  assert.match(script, new RegExp(PAGE_NAME));
  assert.match(script, /function shapeLines\(/);
  assert.doesNotMatch(script, /new Function|\beval\(/);
});

test('an event of the copy\'s stream reaches the page\'s listener with the plan\'s keys laid over it; other events as sent', () => {
  const script = initScript({ status: { over: { gaming: false, where: { room: 'desk' } } } });
  assert.match(script, /function overEvents\(/);
  assert.doesNotMatch(script, /new Function|\beval\(/);
  assert.doesNotMatch(initScript(), /overEvents/, 'a plan with no events leaves the stream alone');
  // The stream of a page, as far as the function reads it.
  class FakeSource { addEventListener(type, listener) { (this.heard ??= []).push([type, listener]); } }
  class FakeMessage { constructor(type, init) { Object.assign(this, { type }, init); } }
  const real = { EventSource: globalThis.EventSource, MessageEvent: globalThis.MessageEvent };
  const got = [];
  try {
    Object.assign(globalThis, { EventSource: FakeSource, MessageEvent: FakeMessage });
    overEvents({ status: { over: { gaming: false, where: { room: 'desk' } } } });
    const source = new FakeSource();
    source.addEventListener('status', (event) => got.push(event.data));
    source.addEventListener('media', (event) => got.push(event.data));
    const [[, status], [, media]] = source.heard;
    status({ data: JSON.stringify({ gaming: true, muted: true, where: { room: 'den', floor: 1 } }), origin: 'http://127.0.0.1:3043', lastEventId: '' });
    status({ data: 'not json' });
    media({ data: JSON.stringify({ gaming: true }) });
  } finally {
    Object.assign(globalThis, real);
  }
  assert.deepEqual(got, [JSON.stringify({ gaming: false, muted: true, where: { room: 'desk', floor: 1 } }), 'not json', JSON.stringify({ gaming: true })]);
});

test('the events of a plan are named as the stream names them and are laid over, never invented whole', () => {
  assert.deepEqual(planProblems({ ...PLAN, events: { status: { over: { gaming: false } } } }), []);
  assert.equal(planProblems({ ...PLAN, events: [] }).length, 1);
  assert.equal(planProblems({ ...PLAN, events: { 'Status!': { over: {} } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, events: { status: { json: { gaming: false } } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, events: { status: { over: [1] } } }).length, 1);
});

test('a plan that can be walked has no problem; each thing missing is said', () => {
  assert.deepEqual(planProblems(PLAN), []);
  assert.deepEqual(planProblems(null), ['a plan is an object']);
  const said = planProblems({ name: 'Bad Name', page: 'https://example.com/', width: 10, height: 600, roots: [], steps: [{ say: 'x', do: 'fly' }, { do: 'click' }, { say: 'typed', do: 'fill', on: '#a' }] }).join('\n');
  for (const part of ['`name`', '`page`', '`width`', '`roots`', '`do` is one of', 'step 2 says what it does', 'a fill needs `text`']) assert.ok(said.includes(part), `${part} in:\n${said}`);
});

test('a page outside the copy is no page of a plan', () => {
  for (const page of ['//example.com/', 'http://127.0.0.1:3030/', 'index.html', '']) assert.equal(planProblems({ ...PLAN, page }).length, 1, page);
});

test('an answer is for a path of the copy and is all invented or laid over; a step may name its own roots', () => {
  assert.deepEqual(planProblems({ ...PLAN, answers: { '/list': { json: { items: [] } }, '/caps': { over: { on: true } } }, steps: [{ ...PLAN.steps[0], roots: ['#part'] }] }), []);
  assert.equal(planProblems({ ...PLAN, answers: { 'https://example.com/list': { json: 1 } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, answers: { '/list?x=1': { json: 1 } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, answers: { '/list': { json: 1, over: {} } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, answers: { '/list': { over: [1] } } }).length, 1);
  assert.equal(planProblems({ ...PLAN, steps: [{ ...PLAN.steps[0], roots: [] }] }).length, 1);
  assert.equal(planProblems({ ...PLAN, background: ['('] }).length, 1);
  assert.equal(planProblems({ ...PLAN, seed: [] }).length, 1);
});

test('what the plan lays over an answer takes its place key by key, lists and plain values whole', () => {
  assert.deepEqual(laidOver({ a: 1, caps: { x: false, y: false }, list: [1, 2] }, { caps: { x: true }, list: [9] }), { a: 1, caps: { x: true, y: false }, list: [9] });
  assert.deepEqual(laidOver(null, { caps: { x: true } }), { caps: { x: true } });
});

test('the form of a value keeps its keys and kinds and nothing it holds', () => {
  assert.deepEqual(shapeOfValue({ title: 'Night lamp', steps: [{ type: 'a', delay: 1 }, { type: 'b', delay: 2 }], on: true, none: null }),
    { none: 'null', on: 'boolean', steps: [{ delay: 'number', type: 'string' }], title: 'string' });
  assert.equal(bodyShape('{"title":"Night lamp","size":2}', 'application/json'), '{"size":"number","title":"string"}');
  assert.equal(bodyShape('b=2&a=1', 'application/x-www-form-urlencoded'), 'fields(a,b)');
  assert.equal(bodyShape('------x', 'multipart/form-data; boundary=x'), 'form');
  assert.equal(bodyShape('hello there'), 'text');
  assert.equal(bodyShape(null), '');
  assert.ok(!bodyShape('{"title":"Night lamp"}').includes('Night lamp'));
});

test('a request is its method, its path, the names it asks and the form of its body', () => {
  assert.equal(requestLine({ method: 'GET', url: 'http://127.0.0.1:3043/deck/app-icon?path=x&size=64&path=y' }), 'GET /deck/app-icon?path&size');
  assert.equal(requestLine({ method: 'POST', url: 'http://127.0.0.1:3043/settings', body: '{"deck":{"keys":[]}}', type: 'application/json' }), 'POST /settings {"deck":{"keys":[]}}');
});

test('the plan\'s replacements are applied to every line', () => {
  assert.equal(replacerOf({ replace: [['\\d\\d:\\d\\d', 'HH:MM'], ['id-[a-z0-9]+', 'id-…']] })('at 12:34 and 09:00 for id-k3x'), 'at HH:MM and HH:MM for id-…');
  assert.equal(replacerOf({})('as it is'), 'as it is');
});

test('two recordings are the same, or the first difference is told with its step and line', () => {
  const step = (say, more = {}) => ({ say, shape: ['div', '  "one"'], focus: 'body', requests: [], errors: [], ...more });
  const before = { plan: 'sample-window', engine: 'chromium', steps: [step('opens'), step('a click')] };
  assert.equal(firstDifference(before, structuredClone(before)), null);
  assert.equal(firstDifference(before, { ...before, steps: [step('opens'), step('a click', { shape: ['div', '  "two"'] })] }), 'step 2 (a click): shape, line 2\n  was:   "one"\n  is:    "two"');
  assert.equal(firstDifference(before, { ...before, steps: [step('opens'), step('a click', { shape: ['div', '  "one"', '  span'] })] }), 'step 2 (a click): shape, line 3\n  was: (nothing)\n  is:    span');
  assert.equal(firstDifference(before, { ...before, steps: [step('opens'), step('a click', { requests: ['POST /settings'] })] }), 'step 2 (a click): requests\n  was: (nothing)\n  is:  POST /settings');
  assert.equal(firstDifference(before, { ...before, steps: [step('opens'), step('a click', { focus: 'input#name' })] }), 'step 2 (a click): focus\n  was: body\n  is:  input#name');
  assert.match(firstDifference(before, { ...before, steps: [step('opens')] }), /step 2 \(a click\): missing now/);
  assert.match(firstDifference(before, { ...before, steps: [...before.steps, step('one more')] }), /step 3 \(one more\): new/);
  assert.match(firstDifference(before, { ...before, engine: 'webkit' }), /two engines/);
  assert.match(firstDifference(before, { ...before, plan: 'other' }), /two plans/);
});

test('every plan kept in the repo can be walked, opens only the copy and holds invented answers only for paths', () => {
  const folder = path.join(REPO_ROOT, 'tools', 'restructure', 'ui-shape');
  const plans = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
  assert.ok(plans.length > 0);
  for (const name of plans) {
    const plan = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    assert.deepEqual(planProblems(plan), [], name);
    assert.equal(`${plan.name}.json`, name);
  }
});
