// Moving what a tool of the assistant does out of the function that runs tools
// (tools/restructure branches, the `tools` kind): the test of each tool and every
// check in front of the chain stay as written, the body is the same bytes in a
// function that declares the result and gives it back, and the function answers
// as before, a body that throws included.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { moveBranches, surveyBranches } from '../../tools/restructure/branches.mjs';
import { kindOf, ROUTES, TOOLS } from '../../tools/restructure/branches-kinds.mjs';
import { paramsFor, planBranches, tableOf } from '../../tools/restructure/branches-plan.mjs';
import { proveBranches } from '../../tools/restructure/branches-proof.mjs';
import { callLine, entryLines, readCall, readModule, undoBranchesText } from '../../tools/restructure/branches-text.mjs';
import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { idOf, rewrite } from './restructure-branches-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const OLD = 'server/demo.js';
const TABLE = 'server/ai/tools.js';
const ABOUT = 'What the tools for notes do.';
const SOURCE = `const fs = require('fs');
const notes = require('./notes-lib');

const LIMIT = notes.limit + fs.constants.F_OK;

// Runs one tool for the assistant.
async function runAiTool(fnName, fnArgs, deps) {
  const { uiLang, remote = false, provider, pictures = [], surface = '', apiKey, latestUserText } = deps;
  const clientActions = [];
  let pending = null;
  let fnResult;
  const phoneRefusal = (error) => ({ ok: false, error });
  const runAction = async (action) => (remote ? phoneRefusal('not_on_phone') : { ran: action });
  if (remote && fnName === 'lock') {
    return { fnResult: phoneRefusal('pc_only'), clientActions, pending };
  }
  if (fnName === 'open') {
    clientActions.push({ action: fnName });
    fnResult = { ok: true };
    return { fnResult, clientActions, pending };
  }

  try {
    if (fnName === 'add_note') {
      // Writes one note.
      const text = String(fnArgs.text || '').trim();
      if (!text) { fnResult = { error: 'empty' }; }
      else {
        fnResult = { ok: true, count: notes.add(text) };
        clientActions.push({ action: 'notes_changed' });
      }
    } else if (fnName === 'read_file') {
      if (!fnArgs.file) fnResult = { error: 'no_file' };
      else fnResult = { exists: fs.existsSync(String(fnArgs.file)), lang: uiLang };
    } else if (fnName === 'boom') {
      fnResult = { half: true };
      if (fnArgs.what) throw new Error(\`no \${fnArgs.what}\`);
      fnResult = { whole: true };
    } else if (fnName === 'run') {
      fnResult = { asked: fnArgs.action };
      fnResult = await runAction(fnArgs.action);
    } else if (fnName === 'once') {
      fnResult = { ok: fnArgs.ok };
    } else if (fnName === 'limit') {
      fnResult = { limit: LIMIT };
    } else if (fnName === 'early') {
      if (!fnArgs.ok) return { fnResult: { error: 'no' }, clientActions, pending };
      fnResult = { ok: true };
    } else if (fnName === 'screen') {
      pending = { shot: 1 };
      fnResult = { ok: true };
    } else if (fnName === 'bare') {
      if (!fnArgs.ok) return;
      fnResult = { ok: true };
    } else if (fnName === 'a' || fnName === 'b') {
      fnResult = { ok: fnName };
    } else {
      fnResult = { error: 'unknown_function' };
    }
  } catch (fnErr) {
    fnResult = { error: fnErr.message };
  }

  return { fnResult, clientActions, pending };
}

module.exports = { runAiTool };
`;
const MOVED = ['add_note', 'read_file', 'boom', 'run'];
const ALLOWED = new Set(['runAiTool']);
const HANDED = `{ ${TOOLS.context.join(', ')} }`;

const plan = (keys, more = {}) => planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: ABOUT, keys, moduleBefore: null, rewrite, allowed: ALLOWED, ...more });
const refusal = (keys, more) => {
  try { plan(keys, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (made, more = {}) => proveBranches({ before: SOURCE, after: made.newSource, moduleBefore: null, moduleText: made.moduleText, plan: made,
  parser, source: OLD, target: TABLE, idOf, ...more });
const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the sample has ${JSON.stringify(from)} once`); return text.replace(from, () => to); };

test('a table of tools is said by its file name, and its lines are read back as what they say', () => {
  assert.deepEqual([kindOf('server/ai/tools.js'), kindOf('./notes/tools-more.js'), kindOf('server/notes/routes-tools.js'), kindOf('server/notes/toolsmith.js')], [TOOLS, TOOLS, ROUTES, null]);
  assert.deepEqual(tableOf(OLD, TABLE), { local: 'aiToolsBranches', spec: './ai/tools.js', kind: TOOLS });
  assert.equal(tableOf(OLD, 'server/screen-notes/tools-more.js').local, 'screenNotesToolsMoreBranches');
  const line = callLine('aiToolsBranches', 'add_note', TOOLS);
  assert.equal(line, `      fnResult = await aiToolsBranches['add_note'](${HANDED});`);
  assert.deepEqual([readCall(line, TOOLS), readCall(line), readCall(callLine('lightsBranches', 'GET /a'), TOOLS)], [{ local: 'aiToolsBranches', key: 'add_note' }, null, null]);
  assert.deepEqual(entryLines(['      fnResult = 1;'], TOOLS), ['      let fnResult;', '      fnResult = 1;', '      return fnResult;']);
  assert.deepEqual([paramsFor(['fnArgs', 'clientActions'], TOOLS), paramsFor(['uiLang', 'fnArgs'], TOOLS), paramsFor([], TOOLS)], ['{ fnArgs, clientActions }', '{ fnArgs, uiLang }', '']);
});

test('the bodies of tools move as written into functions that give the result back, and the move proves itself', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(MOVED);
  assert.deepEqual(proven(made), []);
  assert.deepEqual(made.keys, MOVED);
  const module = readModule(made.moduleText);
  assert.equal(module.kind, TOOLS);
  assert.deepEqual(module.entries.map((entry) => [entry.key, entry.params]), [['add_note', '{ fnArgs, clientActions }'], ['read_file', '{ fnArgs, uiLang }'], ['boom', '{ fnArgs }'], ['run', '{ fnArgs, runAction }']]);
  assert.ok(made.moduleText.includes(["  'boom': async ({ fnArgs }) => {", '      let fnResult;', '      fnResult = { half: true };', '      if (fnArgs.what) throw new Error(`no ${fnArgs.what}`);', '      fnResult = { whole: true };', '      return fnResult;', '  },'].join('\n')));
  assert.ok(made.moduleText.includes("/** @type {Record<string, (context: any) => Promise<any>>} */\nconst branches = {\n  'add_note': async"));
  const lines = made.newSource.split('\n');
  assert.equal(lines[lines.indexOf("    } else if (fnName === 'run') {") + 1], callLine('aiToolsBranches', 'run', TOOLS));
  assert.equal(lines.indexOf("const { branches: aiToolsBranches } = require('./ai/tools.js');") + 2, lines.indexOf('// Runs one tool for the assistant.'), 'the table is required right above the function');
  assert.equal(undoBranchesText(made.newSource, () => made.moduleText), SOURCE, 'read as text, the bodies are back under their tests');
  const survey = surveyBranches({ text: SOURCE, parser, source: OLD, kind: TOOLS });
  assert.deepEqual([survey.branches, survey.movable.map((row) => row.key), survey.held.map((row) => row.name)], [10, MOVED, ['LIMIT']]);
  assert.ok(survey.other.some((row) => /^it sets fnResult once, in a line of its own/.test(row.reason) && row.branches === 6), 'a body that sets the result just once is counted with what keeps it');
});

test('a body that would end the function, or set something else of it, stays; so does every body when the function is not safe to call them from', (t) => {
  if (!parser) return t.skip(SKIP);
  const said = refusal(['limit', 'early', 'screen', 'bare', 'once', 'a', 'nothing']);
  for (const reason of [/once \(server\/demo\.js:\d+\): it sets fnResult once, in a line of its own: a function that declares it first would read as code to rewrite/,
    /limit \(server\/demo\.js:\d+\): it needs LIMIT, which the file still declares/, /early .*it has a `return`/, /bare .*it has a `return`/,
    /screen .*it uses pending, which the handler works out for itself/, /0 branches of runAiTool answer a, one was expected/, /0 branches of runAiTool answer nothing/]) assert.match(said, reason);
  assert.match(refusal(['run'], { allowed: new Set(['handleRequest']) }), /protected\.json does not let the bodies of runAiTool move/);
  assert.match(refusal(['run'], { target: 'server/ai/routes.js' }), /protected.json does not let the bodies of handleRequest move/);
  const stays = swap(SOURCE, "    fnResult = { ok: true };\n    return { fnResult, clientActions, pending };\n  }\n\n  try", "    fnResult = { ok: true };\n  }\n\n  try");
  assert.match(refusal(['run'], { text: stays }), /fnResult may have a value when the chain starts/);
  assert.match(refusal(['run'], { text: swap(SOURCE, '  let fnResult;\n', '  let fnResult = null;\n') }), /does not declare fnResult with `let fnResult;`/);
  assert.match(refusal(['run'], { text: swap(SOURCE, '    fnResult = { error: fnErr.message };', '    pending = fnResult;\n    fnResult = { error: fnErr.message };') }), /when a body throws, the function does not set fnResult again first thing/);
  assert.match(refusal(['run'], { text: swap(SOURCE, "  }\n\n  return { fnResult, clientActions, pending };", "  } finally {\n    pending = fnResult;\n  }\n\n  return { fnResult, clientActions, pending };") }), /a try with a `finally`/);
  assert.match(refusal(['boom'], { text: swap(SOURCE, ', apiKey, latestUserText } = deps;', ', latestUserText } = deps;') }), /the function has no apiKey above the chain, and every call hands it over/);
  assert.match(refusal(['run'], { text: swap(SOURCE, '  let pending = null;', '  let pending = null;\n  if (!fnArgs) fnArgs = {};') }), /the function assigns fnArgs, which a body would be handed once/);
  assert.equal(refusal(['boom'], { text: swap(SOURCE, '  let pending = null;', "  let pending = null;\n  if (remote) deps = { ...deps, uiLang: 'en' };") }), '', 'what no body is handed may change');
  assert.match(refusal(['run'], { text: swap(SOURCE, '// Runs one tool', "const first = runAiTool('open', {}, {});\n\n// Runs one tool") }), /line 6 of server\/demo\.js runs while the file loads and may reach runAiTool before the line that requires the table/);
  assert.match(refusal(['run'], { text: swap(SOURCE, "  try {\n    if (fnName === 'add_note')", "  try {\n    pending = 1;\n    if (fnName === 'add_note')") }), /the try block of runAiTool is not one chain of tools and nothing else/);
});

test('the proof stands on the three texts: a changed body, a `return` slipped in, a changed function are all seen', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(MOVED);
  assert.match(proven(made, { moduleText: swap(made.moduleText, "exists: fs.existsSync(String(fnArgs.file))", "exists: !fs.existsSync(String(fnArgs.file))") }).join('\n'), /the body of read_file in server\/ai\/tools\.js is not the old lines byte for byte/);
  assert.match(proven(made, { moduleText: swap(made.moduleText, "      fnResult = { half: true };\n", "      fnResult = { half: true };\n      if (fnResult) return;\n") }).join('\n'), /boom has a `return`/);
  assert.match(proven(made, { moduleText: swap(made.moduleText, "      fnResult = { whole: true };\n      return fnResult;\n", "      fnResult = { whole: true };\n") }).join('\n'), /the function of boom does not declare fnResult first and give it back last/);
  assert.match(proven(made, { after: swap(made.newSource, '    fnResult = { error: fnErr.message };', '    fnResult = { error: String(fnErr.message) };') }).join('\n'), /runAiTool changed after its chain/);
  assert.match(proven(made, { after: swap(made.newSource, "fnName === 'boom'", "fnName === 'bang'") }).join('\n'), /the tests of runAiTool are not the same, in the same order/);
  assert.match(proven(made, { after: swap(made.newSource, "    return { fnResult: phoneRefusal('pc_only'), clientActions, pending };\n", '') }).join('\n'), /runAiTool changed before its chain/);
  assert.match(proven(made, { target: 'server/ai/routes.js' }).join('\n'), /holds a table of tools, its name says routes/);
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-tools-'));
  for (const folder of ['server', 'tools/restructure', 'tools/map']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, PROTECTED), '{ "files": { "server/demo.js": { "names": [], "branches": ["runAiTool"] } } }\n');
  writeFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), '{}\n');
  writeFileSync(path.join(root, 'server', 'notes-lib.js'), 'const all = [];\nmodule.exports = { limit: 3, add: (text) => all.push(text) };\n');
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}

// What the function of a folder gives back for a few tools, as text.
async function resultsOf(root) {
  const { runAiTool } = createRequire(path.join(root, 'server', 'x.js'))('./demo.js');
  const asked = [['add_note', { text: ' milk ' }], ['add_note', { text: '' }], ['add_note', { text: 'eggs' }], ['read_file', { file: '.' }], ['boom', { what: 'luck' }], ['run', { action: 'lock' }],
    ['run', { action: 'lock' }, { remote: true }], ['lock', {}, { remote: true }], ['open', {}], ['limit', {}], ['once', { ok: 1 }], ['boom', {}], ['read_file', {}], ['early', {}], ['screen', {}], ['nothing', {}], ['add_note', null]];
  const out = [];
  for (const [name, args, more] of asked) out.push(`${name} ${JSON.stringify(await runAiTool(name, args, { uiLang: 'it', ...more }))}`);
  return out;
}

test('on disk: the move is written and recorded, the replay redoes it, and the function gives back the same for every tool', async (t) => {
  if (!parser) return t.skip(SKIP);
  const [root, untouched] = [demoRepo(), demoRepo()];
  try {
    moveBranches({ root, parser, source: OLD, target: TABLE, about: ABOUT, keys: ['add_note', 'boom'] });
    moveBranches({ root, parser, source: OLD, target: TABLE, keys: ['run', 'read_file'] });
    assert.deepEqual(readLedger(root).branches, { [OLD]: [{ file: TABLE, about: ABOUT, keys: ['add_note', 'boom'], after: 0 }, { file: TABLE, about: '', keys: ['read_file', 'run'], after: 0 }] });
    assert.deepEqual(readModule(readFileSync(path.join(root, TABLE), 'utf8')).entries.map((entry) => entry.key), ['add_note', 'boom', 'read_file', 'run']);
    const results = await resultsOf(root);
    assert.deepEqual(results, await resultsOf(untouched), 'run for real, both functions give back the same');
    assert.equal(results[4], 'boom {"fnResult":{"error":"no luck"},"clientActions":[],"pending":null}', 'a body that set the result and then threw leaves only the error');
    assert.equal(results[0], 'add_note {"fnResult":{"ok":true,"count":1},"clientActions":[{"action":"notes_changed"}],"pending":null}');
    assert.equal(results[6], 'run {"fnResult":{"ok":false,"error":"not_on_phone"},"clientActions":[],"pending":null}', 'the check a body calls is the function\'s own');
    const fromStart = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromStart }), { problems: [], replayed: 2, files: [[OLD, TABLE]] });
    const table = readFileSync(path.join(root, TABLE), 'utf8');
    writeFileSync(path.join(root, TABLE), swap(table, "throw new Error(`no ${fnArgs.what}`);", "throw new Error(`not ${fnArgs.what}`);"));
    assert.match(replay({ root, parser, base: 'BASE', show: fromStart }).problems.join('\n'), /server\/ai\/tools\.js is not what the tool writes/);
  } finally {
    for (const folder of [root, untouched]) rmSync(folder, { recursive: true, force: true });
  }
});
