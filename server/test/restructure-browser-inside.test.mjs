// `tools/restructure/browser-inside.mjs` cuts lines out of ONE FUNCTION of a browser script
// into a script that is handed what they use, and `browser-inside-proof.mjs` is the
// standing check of such a script. A function too long for one file is cut this way only
// while moving lines is enough: these tests hold what the tool works out (what is handed,
// what comes back), what it refuses before writing, and what the check refuses after.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { cutByHand } from '../../tools/restructure/browser-by-hand.mjs';
import { insideStateProblems, readInsideScript } from '../../tools/restructure/browser-inside-proof.mjs';
import { planInside } from '../../tools/restructure/browser-inside.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = parser ? false : 'TypeScript is not installed here (npm run quality:install)';

const FROM = 'server/js/sample.js';
const TO = 'server/js/sample/rows.js';
const SOURCE = [
  "'use strict';",
  '(function () {',
  '  const t = (key) => key;',
  '  let opened = 0;',
  '  function open(opts) {',
  "    const box = document.createElement('div');",
  "    let active = 'a';",
  '    const title = opts.title;',
  "    box.addEventListener('click', () => paint());",
  '    // Builds one row.',
  '    function row(text) {',
  "      const el = document.createElement('p');",
  '      el.textContent = t(text) + title;',
  '      return el;',
  '    }',
  '    function paint() {',
  '      box.replaceChildren(row(active));',
  '    }',
  "    const head = row('head');",
  "    const foot = row('foot');",
  '    box.appendChild(head);',
  "    active = 'b';",
  '    box.appendChild(foot);',
  '    opened += 1;',
  '    return box;',
  '  }',
  '  window.Sample = { open };',
  '})();',
  '',
].join('\n');

const lineOf = (text, start) => { const at = text.split('\n').findIndex((line) => line.trim().startsWith(start)); assert.ok(at >= 0, start); return at + 1; };
const span = (text, first, last) => [lineOf(text, first), lineOf(text, last)];
const reasonsOf = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons; throw error; } return []; };

// Plans a cut, writes the two texts and asks the standing check.
function cutAndCheck(text, ranges, at) {
  const worked = planInside({ text, from: FROM, inside: 'open', ranges, at, parser });
  const cut = cutByHand({ text, from: FROM, to: TO, about: 'The rows of the sample window.', ranges, ...worked, inside: 'open' });
  const problems = insideStateProblems({ source: FROM, text: cut.newSource, parts: [{ file: TO, text: cut.targetText, inside: 'open', name: cut.record.name }], parser });
  return { worked, cut, problems };
}

test('a function of the function leaves with what it uses handed in, and the function takes it back in its place', { skip: SKIP }, () => {
  const { worked, cut, problems } = cutAndCheck(SOURCE, [[lineOf(SOURCE, '// Builds one row.'), lineOf(SOURCE, '}')]]);
  assert.deepEqual(worked.hands, ['t', 'title']);
  assert.deepEqual(worked.gives, ['row']);
  assert.deepEqual(problems, []);
  assert.equal(cut.record.inside, 'open');
  assert.equal(cut.record.hand, true);
  assert.match(cut.targetText, /^\/\/ The rows of the sample window\.\n'use strict';\n\nwindow\.SampleRows = \(wrapper\) => \{\n {4}const \{ t, title \} = wrapper;\n\n {4}\/\/ Builds one row\.\n {4}function row\(text\) \{/);
  assert.match(cut.targetText, /\n {4}return \{ row \};\n\};\n$/);
  assert.match(cut.newSource, /\n {4}box\.addEventListener\('click', \(\) => paint\(\)\);\n {4}const \{ row \} = window\.SampleRows\(\{ t, title \}\);\n\n {4}function paint\(\) \{/);
  // Only lines moved: every line of the old script is in one of the two texts, once.
  const kept = new Set([...cut.newSource.split('\n'), ...cut.targetText.split('\n')]);
  for (const line of SOURCE.split('\n')) assert.ok(kept.has(line), line);
});

test('a run of statements leaves as one run, and what it declares for the rest comes back in order', { skip: SKIP }, () => {
  const { worked, problems } = cutAndCheck(SOURCE, [span(SOURCE, "const head = row('head');", "const foot = row('foot');")]);
  assert.deepEqual(worked.hands, ['row']);
  assert.deepEqual(worked.gives, ['head', 'foot']);
  assert.deepEqual(problems, []);
});

test('the tool refuses a part of a statement, a statement that stays between the ones that leave, and lines nobody uses', { skip: SKIP }, () => {
  const plan = (ranges, at) => reasonsOf(() => planInside({ text: SOURCE, from: FROM, inside: 'open', ranges, at, parser })).join('\n');
  assert.match(plan([[lineOf(SOURCE, 'function row(text) {'), lineOf(SOURCE, 'el.textContent')]]), /one statement of open: it leaves whole or stays/);
  assert.match(plan([[lineOf(SOURCE, "const head = row('head');"), lineOf(SOURCE, "const head = row('head');")], [lineOf(SOURCE, 'box.appendChild(head);'), lineOf(SOURCE, 'box.appendChild(head);')]]), /stay and run between the lines that leave/);
  assert.match(plan([span(SOURCE, "const head = row('head');", "const foot = row('foot');")], lineOf(SOURCE, 'opened += 1;')), /the order would change/);
  assert.match(plan([[lineOf(SOURCE, 'box.appendChild(foot);'), lineOf(SOURCE, 'box.appendChild(foot);')]]), /gives at least one name back/);
  assert.match(plan([[3, 3]]), /not inside open/);
  assert.match(reasonsOf(() => planInside({ text: SOURCE, from: FROM, inside: 'close', ranges: [[6, 6]], parser })).join('\n'), /0 functions called close/);
});

test('a function declaration may be taken back lower down, where what it is handed exists', { skip: SKIP }, () => {
  const rows = [[lineOf(SOURCE, '// Builds one row.'), lineOf(SOURCE, '}')]];
  assert.deepEqual(cutAndCheck(SOURCE, rows, lineOf(SOURCE, 'function paint() {')).problems, []);
  const early = cutAndCheck(SOURCE, rows, lineOf(SOURCE, 'const title = opts.title;')).problems.join('\n');
  assert.match(early, /hands title above the line that declares it/);
});

test('the check refuses a handed name that is written somewhere: the script would keep a copy', { skip: SKIP }, () => {
  const { worked, problems } = cutAndCheck(SOURCE, [span(SOURCE, 'function paint() {', '}')].map(([first]) => [first, first + 2]));
  assert.deepEqual(worked.hands, ['active', 'box', 'row']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is handed active, which server\/js\/sample\.js:\d+ writes to/);
});

test('the check refuses a name that can be reached before the line that takes it, and lets a listener wait', { skip: SKIP }, () => {
  const rows = (text) => [[lineOf(text, '// Builds one row.'), lineOf(text, '}')]];
  const direct = SOURCE.replace("    box.addEventListener('click', () => paint());", "    box.appendChild(row('first'));");
  assert.match(cutAndCheck(direct, rows(direct)).problems.join('\n'), /sample\.js:9 can reach row before the line that takes it/);
  const named = SOURCE.replace("    box.addEventListener('click', () => paint());", '    paint();');
  assert.match(cutAndCheck(named, rows(named)).problems.join('\n'), /can reach row before the line that takes it/);
  const each = SOURCE.replace("    box.addEventListener('click', () => paint());", "    ['a'].forEach((name) => box.appendChild(row(name)));");
  assert.match(cutAndCheck(each, rows(each)).problems.join('\n'), /can reach row before the line that takes it/);
  const waiting = SOURCE.replace("    box.addEventListener('click', () => paint());", "    box.addEventListener('click', paint);\n    setTimeout(() => row('later'), 10);");
  assert.deepEqual(cutAndCheck(waiting, rows(waiting)).problems, []);
});

test('the check refuses `this`, `arguments` and a `return` of the function among the lines that left', { skip: SKIP }, () => {
  const made = (lines) => readInsideScript(['// Sample.', "'use strict';", '', 'window.SampleRows = (wrapper) => {', '    const { t } = wrapper;', '', ...lines, '', '    return { row };', '};', ''].join('\n'), TO, 'SampleRows', parser).problems.join('\n');
  assert.equal(made(['    function row() { return t(this.name) + arguments.length; }']), '');
  assert.match(made(['    const self = this;', '    function row() { return t(self); }']), /uses `this` of the function it left/);
  assert.match(made(['    const row = () => t(arguments[0]);']), /uses `arguments` of the function it left/);
  assert.match(made(['    if (!t) return null;', '    function row() { return 1; }']), /holds a `return` of the function it left/);
  assert.match(made(['    function row() { t = null; return wrapper; }']), /writes to t, which it was handed[\s\S]*reads `wrapper` again/);
});

test('the check refuses a script that uses a name of the function it was not handed, or one the function takes in another order', { skip: SKIP }, () => {
  const { cut } = cutAndCheck(SOURCE, [[lineOf(SOURCE, '// Builds one row.'), lineOf(SOURCE, '}')]]);
  const check = (text, part) => insideStateProblems({ source: FROM, text, parts: [{ file: TO, text: part, inside: 'open', name: 'SampleRows' }], parser }).join('\n');
  assert.match(check(cut.newSource, cut.targetText.replace('t(text) + title', 't(text) + title + box.id')), /rows\.js uses box of server\/js\/sample\.js and is not handed it/);
  assert.match(check(cut.newSource.replace('({ t, title })', '({ title, t })'), cut.targetText), /hands title, t to server\/js\/sample\/rows\.js, which takes t, title, in that order/);
  assert.match(check(cut.newSource.replace('    const { row } = window.SampleRows({ t, title });\n', ''), cut.targetText), /must take server\/js\/sample\/rows\.js once, on one line right in open/);
  assert.match(check(cut.newSource, cut.targetText.replace('window.SampleRows = (wrapper) => {', 'window.SampleRows = function (wrapper) {')), /must be one `window\.SampleRows = \(wrapper\) => \{ … \};`/);
});

test('the check refuses a name given back that either side writes to afterwards', { skip: SKIP }, () => {
  const counted = SOURCE.replace("    const head = row('head');", ['    let shown = t.length;', '    function count() { shown += 1; return shown; }', "    const head = row('head');"].join('\n')).replace('    opened += 1;', '    opened += count() + shown;');
  const inPart = cutAndCheck(counted, [[lineOf(counted, 'let shown = t.length;'), lineOf(counted, 'function count()')]]);
  assert.deepEqual(inPart.worked.gives, ['shown', 'count']);
  assert.match(inPart.problems.join('\n'), /rows\.js:\d+ writes to shown, which it gives back/);
  const inSource = cutAndCheck(counted, [[lineOf(counted, 'let shown = t.length;'), lineOf(counted, 'let shown = t.length;')]]);
  assert.match(inSource.problems.join('\n'), /sample\.js:\d+ writes to shown, which it took from server\/js\/sample\/rows\.js/);
});

test('lines that use nothing of the function leave as a script that takes nothing, and still run only when the function does', { skip: SKIP }, () => {
  const { worked, cut, problems } = cutAndCheck(SOURCE, [[6, 6]]);
  assert.deepEqual(worked, { hands: [], gives: ['box'], at: 6 });
  assert.deepEqual(problems, []);
  assert.ok(cut.targetText.includes('window.SampleRows = () => {'), cut.targetText);
  assert.ok(cut.newSource.includes('    const { box } = window.SampleRows();'), cut.newSource);
});
