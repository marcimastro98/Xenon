// A decision about markup, an address, an attribute or a style stays in its script
// (tools/restructure/browser-inner-decides.mjs): every reason that keeps a function in
// its wrapper, what may leave all the same, the proof a helper that is handed its tag
// must pass, the helpers of the page a script may take under another name
// (browser-page-helpers.mjs), and the list of what moved before the rule.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ownReasons } from '../../tools/restructure/browser-inner-judge.mjs';
import { readWrapper } from '../../tools/restructure/browser-inner-plan.mjs';
import { innerStateProblems } from '../../tools/restructure/browser-inner-proof.mjs';
import { surveyScript } from '../../tools/restructure/browser-inner-survey.mjs';
import { readBrowserLedger } from '../../tools/restructure/browser-ledger.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { MOVED_BEFORE_RULE, PAGE_HELPERS, pageHelperProblems } from '../../tools/restructure/browser-page-helpers.mjs';
import { pageHelperState } from '../../tools/restructure/browser-state.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable, REPO_ROOT } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const TARGET = 'server/js/leaf/rows.js';
const LATER = 'server/js/leaf/more.js';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/page-kit.js"></script>\n<script src="js/leaf.js"></script>\n</body>\n';
const EL = ['  function el(tag, cls, text) {', '    const n = document.createElement(tag);', '    if (cls) n.className = cls;', '    if (text != null) n.textContent = text;', '    return n;', '  }', ''];
const wrapper = (...inside) => ["'use strict';", '// What the leaf does.', '(function () {', ...inside.flat(), '  window.Leaf = { probe };', '})();', ''].join('\n');
const probe = (...body) => ['  function probe(n, x) {', ...body.map((line) => `    ${line}`), '    return n;', '  }', ''];
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const move = (text, names, more = {}) => applyMove(treeOf({ [FILE]: text, [PAGE]: HTML, ...more.files }),
  { kind: 'inner', from: FILE, file: more.to ?? TARGET, about: 'The rows of the leaf.', names }, { parser, pages: [PAGE], earlier: more.earlier ?? [] });
// Asked to move `probe` with the helper `el`: the reasons, or '' when it moves.
const why = (...body) => refusal(() => move(wrapper(EL, probe(...body), '  function show() { return probe(el(\'p\'), 1); }', ''), ['el', 'probe']));

test('a function that names a way to turn text into markup or code stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const cases = [['n.innerHTML = x;', /names `innerHTML`/], ['n.outerHTML = x;', /names `outerHTML`/], ["n.insertAdjacentHTML('beforeend', x);", /names `insertAdjacentHTML`/],
    ['new DOMParser();', /names `DOMParser`/], ['n.srcdoc = x;', /names `srcdoc`/], ["n['innerHTML'] = x;", /names `innerHTML`/], ['n.sandbox.add(x);', /names `sandbox`/],
    ['document.createRange().createContextualFragment(x);', /names `createContextualFragment`/], ["Function('return 1')();", /makes code out of text with `Function\(`/],
    ["new Function('a', x);", /makes code out of text with `Function\(`/], ['document.write(x);', /calls `document\.write`/], ['n.ownerDocument.writeln(x);', /calls `document\.writeln`/]];
  for (const [line, reason] of cases) assert.match(why(line), reason, line);
  assert.match(why('n.innerHTML = x;'), /probe \(server\/js\/leaf\.js:11\) names `innerHTML` \(line 12\): a decision about markup, an address, an attribute or a style stays in its script/, 'the reason names the function and the line');
});

test('a function that assigns an address stays, and so does one that writes it into an object', (t) => {
  if (!parser) return t.skip(SKIP);
  for (const prop of ['href', 'src', 'action', 'srcset', 'formAction', 'poster', 'location']) assert.match(why(`n.${prop} = x;`), new RegExp(`assigns \`\\.${prop}\``), prop);
  assert.match(why("n['href'] = x;"), /assigns `\.href`/);
  assert.match(why("n.href += '#top';"), /assigns `\.href`/, 'any assignment, whatever the value');
  assert.match(why('send({ href: x });'), /writes `href` into an object with a value that is not written out/);
  assert.match(why('const src = x;', 'send({ src });'), /writes `src` into an object/);
  assert.match(why('send({ style: x });'), /writes `style` into an object/);
  assert.equal(why("send({ src: 'img/leaf.png', action: 'open' });"), '', 'a value written out decides nothing');
  assert.equal(why('const at = n.href;', "if (n.src === 'a') send(at);"), '', 'reading an address is not setting it');
  for (const line of ["window.open(x, '_blank');", 'window.open();', 'location.assign(x);', 'window.location.replace(x);', 'globalThis.open(`${x}/shop`);']) assert.match(why(line), /opens an address that is not written out/, line);
  for (const line of ["window.open('https://example.com/shop', '_blank');", "location.assign('/');", "x.replace('a', n);", 'Object.assign(n, {});', 'menu.open(x);']) assert.equal(why(line), '', line);
});

test('setAttribute moves only with a safe name written out', (t) => {
  if (!parser) return t.skip(SKIP);
  for (const name of ['class', 'id', 'role', 'title', 'type', 'for', 'tabindex', 'hidden', 'disabled', 'draggable', 'aria-label', 'data-key']) assert.equal(why(`n.setAttribute('${name}', x);`), '', name);
  assert.equal(why("n.toggleAttribute('hidden', x);"), '');
  const cases = [["n.setAttribute('viewBox', x);", /calls setAttribute with `'viewBox'`, which is not a safe attribute written out/], ['n.setAttribute(x, 1);', /calls setAttribute with `x`/],
    ["n.setAttribute('style', x);", /calls setAttribute with `'style'`/], ["n.setAttribute('onclick', x);", /calls setAttribute with `'onclick'`/], ['n.toggleAttribute(x);', /calls toggleAttribute with `x`/],
    ["n.setAttributeNS(null, 'd', x);", /calls setAttributeNS with `'d'`/], ['n.setAttributeNode(x);', /calls setAttributeNode/], ["n.setAttribute('data-' + x, 1);", /calls setAttribute with/]];
  for (const [line, reason] of cases) assert.match(why(line), reason, line);
});

test('a style moves only when its value is written out, and a style object is never handed on', (t) => {
  if (!parser) return t.skip(SKIP);
  const stays = [["n.style.width = x + 'px';", /sets a style from a value that is not written out: `n\.style\.width = x \+ 'px'`/], ["n.style.setProperty('--at', x);", /sets a style from a value that is not written out/],
    ['n.style.cssText = x;', /sets a style from a value/], ["n.style[x] = 'none';", /sets a style from a value/], ["n.style.opacity += 1;", /sets a style from a value/], ['n.style = x;', /sets a style from a value/],
    ['const s = n.style;', /hands a style object on/], ['Object.assign(n.style, x);', /hands a style object on/], ['paint(n.style);', /hands a style object on/]];
  for (const [line, reason] of stays) assert.match(why(line), reason, line);
  for (const line of ["n.style.display = x ? '' : 'none';", "n.style.setProperty('--at', '1');", "n.style.width = '100%';", "if (x.style === 'solid') send(n.style.width);", 'if (!x.style) send(typeof x.style);', "n.style.removeProperty('width');"]) {
    assert.equal(why(line), '', line);
  }
});

test('an element that runs, loads or styles by being there stays, and so does a tag that is not written out', (t) => {
  if (!parser) return t.skip(SKIP);
  for (const tag of ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'link', 'base', 'meta']) assert.match(why(`n.append(document.createElement('${tag}'));`), new RegExp(`creates a <${tag}> element`), tag);
  assert.match(why("n.append(document.createElement(x ? 'div' : 'SCRIPT'));"), /creates a <SCRIPT> element/);
  assert.equal(why("n.append(document.createElement(x ? 'div' : 'span'), document.createElementNS('http://www.w3.org/2000/svg', 'svg'));"), '');
  assert.match(why('n.append(document.createElement(x));'), /probe \(server\/js\/leaf\.js:11\) creates an element whose tag it is handed, and is not proven to write the rest as text: it uses its argument n for more than text, a class or a safe attribute: `return n;`/);
  assert.match(why('[1].forEach((kind) => n.append(document.createElement(kind)));'), /creates an element whose tag is not written out \(`kind`\), in code that is not a helper declared by name/);
  // Through a proven helper the tag must be written out too.
  assert.equal(why("n.append(el('span', 'row', x), el(x ? 'h2' : 'h3', '', x));"), '', 'text handed to the helper may come from anywhere');
  assert.match(why("n.append(el(x, 'row'));"), /probe \(server\/js\/leaf\.js:11\) calls el with a tag that is not written out \(line 12\)/);
  assert.match(why("n.append(el('script', '', x));"), /creates a <script> element through el \(line 12\)/);
});

test('a helper that is handed its tag must be proven: every use of every argument is text, a class, a test or a safe attribute', (t) => {
  if (!parser) return t.skip(SKIP);
  const helper = (params, ...body) => [`  function el(${params}) {`, '    const n = document.createElement(tag);', ...body.map((line) => `    ${line}`), '    return n;', '  }', ''];
  const asked = (lines) => refusal(() => move(wrapper(lines, probe("n.append(el('p'));"), ''), ['el', 'probe']));
  const proven = [helper('tag, cls, text', 'if (cls) n.className = cls;', 'if (text != null) n.textContent = text;'), helper('tag, text', "n.append(document.createTextNode(String(text || '')));"),
    helper('tag, key, parent', "if (key) n.setAttribute('data-i18n', key);", 'if (parent) parent.appendChild(n);'), helper('tag, cls, onClick', "cls && n.classList.add(cls);", "n.addEventListener('click', onClick);"),
    helper('tag, id, title', 'n.id = id;', "n.title = typeof title === 'string' ? title : '';", 'n.dataset.at = id;')];
  for (const lines of proven) assert.equal(asked(lines), '', lines.join(' '));
  const unproven = [[helper('tag, props', 'Object.assign(n, props);'), /uses its argument props for more than text, a class or a safe attribute: `Object\.assign\(n, props\)`/],
    [helper('tag, props', 'for (const key in props) n[key] = props[key];'), /uses its argument props for more than text/], [helper('tag, name, value', 'n.setAttribute(name, value);'), /calls setAttribute with `name`/],
    [helper('tag, text', 'n.textContent = format(text);'), /uses its argument text for more than text/], [helper('tag, ...rest', 'n.append(...rest);'), /takes its arguments in a pattern or as a rest/],
    [helper('tag, { cls }', 'n.className = cls;'), /takes its arguments in a pattern or as a rest/], [helper('tag, text', 'const tag = text;'), /declares tag again inside/],
    [helper('kind, text', 'n.textContent = text;'), /the tag `tag` is neither written out nor one of its arguments/]];
  for (const [lines, reason] of unproven) assert.match(asked(lines), reason, lines.join(' '));
  const arrow = ['  const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };', ''];
  assert.equal(asked(arrow), '', 'an arrow under a name is a helper too');
  assert.deepEqual(surveyScript(wrapper(EL, probe("n.append(el('p'));"), ''), FILE, parser).helpers, [{ name: 'el', writes: { tag: ['createElement'], cls: ['className'], text: ['textContent'] }, of: null }]);
});

test('what moves with a function is read like the function, also when it was taken from an earlier script', (t) => {
  if (!parser) return t.skip(SKIP);
  const fill = ['  function fill(n, x) {', '    n.innerHTML = x;', '  }', ''];
  const text = wrapper(EL, fill, probe("fill(n, x);", "n.append(el('p'));"), '');
  assert.match(refusal(() => move(text, ['el', 'fill', 'probe'])), /fill \(server\/js\/leaf\.js:11\) names `innerHTML`/, 'moving together does not hide it');
  assert.match(refusal(() => move(text, ['el', 'probe'])), /probe \(server\/js\/leaf\.js:15\) uses fill \(line 11\), a function of the wrapper that stays/);
  // The helper leaves first; a later script takes it and is held to the same proof.
  const first = move(wrapper(EL, probe("n.append(el('p'));"), '  function row(x) { return el(x); }', '').replace('{ probe }', '{ probe, row }'), ['el']);
  const next = (names) => refusal(() => move(first.files.get(FILE), names, { to: LATER, earlier: [first.record], files: { [TARGET]: first.files.get(TARGET), [PAGE]: first.files.get(PAGE) } }));
  assert.equal(next(['probe']), '');
  assert.match(next(['row']), /row \(server\/js\/leaf\.js:\d+\) calls el with a tag that is not written out/);
});

test('a helper of the page may be taken under another name only when it is on the list', (t) => {
  if (!parser) return t.skip(SKIP);
  const aliased = (name) => wrapper(`  const el = ${name};`, '', probe("n.append(el('p', 'row', x));"), '');
  const done = move(aliased('makeEl'), ['el', 'probe']);
  assert.match(done.files.get(TARGET), /^ {2}const el = makeEl;$/m, 'the line goes to the new script as it is');
  assert.match(refusal(() => move(aliased('otherEl'), ['el', 'probe'])), /reads otherEl while the script loads, a name of the page/);
  assert.match(refusal(() => move(aliased('makeEl').replace("el('p', 'row', x)", "el('iframe')"), ['el', 'probe'])), /creates a <iframe> element through el/);
  assert.match(refusal(() => move(aliased('makeEl').replace("el('p', 'row', x)", "makeEl(x, 'row')"), ['probe'])), /calls makeEl with a tag that is not written out/, 'called by its own name too');
  assert.deepEqual(surveyScript(aliased('makeEl'), FILE, parser).helpers.map((helper) => [helper.name, helper.of]), [['el', 'makeEl']]);
});

test('the list of page helpers is held to the code', (t) => {
  if (!parser) return t.skip(SKIP);
  const HOME = 'server/js/page-kit.js';
  const entry = { file: HOME, helper: { tag: 0, writes: { tag: ['createElement'], cls: ['className'], text: ['textContent'] } } };
  const made = 'function makeEl(tag, cls, text) {\n  const n = document.createElement(tag);\n  if (cls) n.className = cls;\n  if (text != null) n.textContent = text;\n  return n;\n}\n';
  const ask = ({ home = made, other = 'const el = makeEl;\nel(\'p\');\nif (typeof makeEl === \'function\') makeEl(\'p\');\n', html = HTML, list = entry } = {}) => pageHelperProblems({ name: 'makeEl', parser, entry: list,
    scripts: [{ file: HOME, text: home }, { file: FILE, text: other }, { file: PAGE, text: html }], pages: [{ page: PAGE, html }], takers: [FILE] }).join('\n');
  assert.equal(ask(), '');
  assert.match(ask({ home: made.replace('n.textContent = text', 'n.innerHTML = text') }), /makeEl \(server\/js\/page-kit\.js\) names `innerHTML`: calls to it are not known to be safe/);
  assert.match(ask({ home: made.replace('n.className = cls', 'n.id = cls') }), /writes \{"tag":\["createElement"\],"cls":\["id"\],"text":\["textContent"\]\} and the list says/);
  assert.match(ask({ home: `(function () {\n${made}})();\n` }), /does not declare the function makeEl once at its top level/);
  assert.match(ask({ home: made.replace('document.createElement(tag)', "document.createElement('div')") }), /does not create an element whose tag it is handed/);
  assert.match(ask({ other: 'makeEl = () => null;\n' }), /server\/js\/leaf\.js assigns makeEl: read earlier, it could be another function/);
  assert.match(ask({ other: 'window.makeEl = () => null;\n' }), /server\/js\/leaf\.js assigns makeEl/);
  assert.match(ask({ other: 'function makeEl() {}\n' }), /server\/js\/leaf\.js declares makeEl too/);
  assert.match(ask({ html: HTML.replace('<script src="js/page-kit.js"></script>\n', '') }), /server\/index\.html loads server\/js\/leaf\.js and not server\/js\/page-kit\.js before it/);
  assert.match(ask({ html: HTML.replace('"js/page-kit.js"', '"js/page-kit.js" defer') }), /loads server\/js\/page-kit\.js async, defer or as a module/);
  assert.match(pageHelperProblems({ name: 'nobody', parser, scripts: [], pages: [], takers: [] }).join('\n'), /nobody is not on the list of page helpers/);
  // The list in the repo, read against the repo.
  assert.deepEqual([...PAGE_HELPERS.keys()], ['makeEl']);
  assert.deepEqual(pageHelperState(REPO_ROOT, parser, []), []);
});

test('the survey counts with the rule, and says what it costs', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = wrapper(EL, probe('n.innerHTML = x;'), '  function row(x) { return el(\'li\', \'row\', x); }', '', '  function rows(x) { return probe(row(x), x); }', '').replace('{ probe }', '{ probe, rows }');
  const found = surveyScript(text, FILE, parser);
  assert.deepEqual([found.free.functions, found.held.decides.functions, found.held.needs.functions, found.decided.functions, found.ifDecides.functions], [2, 1, 1, 1, 4]);
  assert.match(found.rows.find((row) => row.name === 'probe').stays[0], /names `innerHTML`/);
  assert.equal(found.rows.find((row) => row.name === 'probe').kind, 'decides');
});

test('a script made of moved functions is held to the rule from then on, but for what moved before it', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = move(wrapper(EL, probe("n.append(el('p'));"), ''), ['el', 'probe']);
  const state = (made, file = TARGET) => innerStateProblems({ source: FILE, text: done.files.get(FILE).replace('LeafRows', file === TARGET ? 'LeafRows' : 'LeafKeyFace'), parts: [{ file, text: made }], parser }).join('\n');
  assert.equal(state(done.files.get(TARGET)), '');
  assert.match(state(done.files.get(TARGET).replace("n.append(el('p'));", 'n.innerHTML = x;')), /server\/js\/leaf\/rows\.js: probe names `innerHTML`/);
  // The list: only functions of recorded moves, each still holding a decision, and never more of them.
  const moves = readBrowserLedger(REPO_ROOT).moves.filter((entry) => entry.kind === 'inner');
  const listed = [...MOVED_BEFORE_RULE].flatMap(([file, names]) => names.map((name) => [file, name]));
  assert.ok(MOVED_BEFORE_RULE.size <= 10 && listed.length <= 18, 'the list of what moved before the rule only gets shorter');
  for (const [file, name] of listed) {
    assert.ok(moves.some((entry) => entry.file === file && entry.names.includes(name)), `${name} is a function a recorded move put into ${file}`);
    const shell = readWrapper(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file, parser);
    const reasons = ownReasons(shell, shell.bindings.get(name).record, name);
    assert.ok(reasons.some((reason) => reason.kind === 'decides'), `${name} in ${file} holds no decision any more: take it off the list`);
  }
});
