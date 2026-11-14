// A require line that leaves a file never takes a comment with it
// (tools/restructure/require-edits.mjs). When moved code was the last user of
// `const x = require('builtin')`, or of a module the tool made, the whole line went, and with it
// the comment block right above. When that block was the header of the file, the header was
// gone and every proof passed. Now a line with a comment above it stays as `require('x');`
// under its comment, where `bare` names it and a person decides.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT] = ['server/demo.js', 'server/part/x.js', 'What the part does.'];
const rewrite = (spec) => ({ spec: `node:${spec}`, kind: 'builtin', file: null });

const HEADER = ['// What this module never does: it never opens a shell,', '// and it never reads a key.'];
const BODY = ['', 'function folder() {', '  return os.tmpdir();', '}', '', "function join(a) { return path.join(a, 'x'); }", '',
  'module.exports = { folder, join };'];
const move = (text) => {
  const plan = planExtraction({ text, analysis: analyze(text, parser, OLD), names: ['folder'], source: OLD, target: NEW, about: ABOUT, rewrite });
  return { plan, proof: proveMove({ before: text, after: plan.newSource, moduleText: plan.moduleText, plan }) };
};

test('the header of a file stays when the require right under it leaves', (t) => {
  if (!parser) return t.skip(SKIP);
  const { plan, proof } = move(file("'use strict';", ...HEADER, "const os = require('os');", "const path = require('path');", ...BODY));
  for (const line of HEADER) assert.ok(plan.newSource.includes(`${line}\n`), `lost: ${line}`);
  assert.ok(plan.newSource.includes(`${HEADER[1]}\nrequire('os');\nconst path = require('path');\n`), 'the line stays without its name, under its comment');
  assert.deepEqual(proof, []);
});

test('a comment about the require itself stays with it too', (t) => {
  if (!parser) return t.skip(SKIP);
  const { plan, proof } = move(file("'use strict';", "const path = require('path');", '// Only for the temp folder.', "const os = require('os');", ...BODY));
  assert.ok(plan.newSource.includes("// Only for the temp folder.\nrequire('os');\n"));
  assert.deepEqual(proof, []);
});

test('a require with no comment above it still leaves whole', (t) => {
  if (!parser) return t.skip(SKIP);
  const { plan, proof } = move(file("'use strict';", ...HEADER, "const path = require('path');", "const os = require('os');", ...BODY));
  assert.equal(plan.newSource.includes("require('os')"), false);
  for (const line of HEADER) assert.ok(plan.newSource.includes(`${line}\n`));
  assert.deepEqual(proof, []);
});
