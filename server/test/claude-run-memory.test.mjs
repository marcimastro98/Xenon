// What the Claude Code runner remembers between calls: the number of the next run, the list of
// projects it read, and whether a change is already on its way to be told. A stand-in program
// takes the place of Claude Code, so a run really starts and really ends. Every wait here is for
// a call or for a run to end, never for a length of time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunner } = require('../claude-run.js');
const { runCaches } = require('../claude-code/run-caches.js');

// The layout the runner reads its projects from: <root>/projects/<name>/<id>.jsonl, each
// transcript naming the folder it belongs to.
async function tree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-run-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const projects = path.join(root, 'projects');
  const addProject = async (name) => {
    const real = path.join(root, 'work', name);
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(path.join(projects, name), { recursive: true });
    await fs.writeFile(path.join(projects, name, 'aaaa.jsonl'), `${JSON.stringify({ type: 'user', cwd: real, sessionId: 'x' })}\n`);
  };
  return { root, projects, addProject };
}
// Calls collected as they come, and a wait for the one that is looked for.
function collected() {
  const calls = [];
  let wake = () => {};
  const take = (value) => { calls.push(value); wake(); };
  const until = async (check) => { while (!check(calls)) await new Promise((resolve) => { wake = resolve; }); };
  return { calls, take, until };
}
const names = (list) => list.map((project) => project.name).sort();

test('each run gets the next number, a change is told after the call that made it, and a listener that throws ends no run', async (t) => {
  const { root, projects, addProject } = await tree(t);
  await addProject('alpha');
  const program = path.join(root, 'stand-in.cjs');
  await fs.writeFile(program, "console.log(JSON.stringify({ type: 'result', result: 'said by the stand-in', session_id: 'session-1' }));\n");
  const kept = runCaches.exec;
  runCaches.exec = { cmd: process.execPath, pre: [program] };
  t.after(() => { runCaches.exec = kept; });

  const told = collected();
  const runner = createRunner({ projectsDir: () => projects, onChange: () => { told.take(runner.snapshot()); throw new Error('a listener that breaks'); } });
  t.after(() => runner.stopAll());
  const ended = (id) => told.until((calls) => calls.some((runs) => runs.some((run) => run.id === id && run.state !== 'running')));
  const [project] = await runner.listProjects();

  const first = await runner.start({ projectId: project.id, prompt: 'say hello' });
  assert.deepEqual([first.ok, first.project], [true, 'alpha']);
  assert.match(first.id, /^r1-/);
  assert.equal(told.calls.length, 0, 'the change is told after the call, not inside it');
  await ended(first.id);
  const second = await runner.start({ projectId: project.id, prompt: 'say hello again' });
  assert.match(second.id, /^r2-/);
  // The second end is watched on the runner itself, so that a change never told again fails here and waits for nothing.
  const turn = () => new Promise((resolve) => { setImmediate(resolve); });
  while (runner.snapshot().some((run) => run.state === 'running')) await turn();
  await turn();
  assert.deepEqual(told.calls.at(-1).map((run) => run.state), ['done', 'done'], 'a change is told again after one has been told');
  assert.deepEqual(runner.snapshot().map((run) => [run.id, run.state, run.output, run.sessionId, run.error]),
    [[first.id, 'done', 'said by the stand-in', 'session-1', ''], [second.id, 'done', 'said by the stand-in', 'session-1', '']]);
});

test('the list of projects is read once a minute, and a forced read or a folder added by hand reads it again', async (t) => {
  const { root, projects, addProject } = await tree(t);
  let time = 1000000;
  const runner = createRunner({ projectsDir: () => projects, now: () => time });
  // A list with nothing in it is not kept: the next call reads again.
  assert.deepEqual(await runner.listProjects(), []);
  await addProject('alpha');
  const first = await runner.listProjects();
  assert.deepEqual(names(first), ['alpha']);

  await addProject('beta');
  assert.equal(await runner.listProjects(), first, 'the list that was read is given again');
  time += 59999;
  assert.equal(await runner.listProjects(), first);
  time += 1;
  const later = await runner.listProjects();
  assert.deepEqual(names(later), ['alpha', 'beta']);

  await addProject('gamma');
  assert.equal(await runner.listProjects(), later);
  const forced = await runner.listProjects(true);
  assert.deepEqual(names(forced), ['alpha', 'beta', 'gamma']);
  assert.equal(await runner.listProjects(), forced, 'and the forced read is the one kept from then on');

  // A folder added by hand shows at once: no minute to wait, no forced read.
  const extra = path.join(root, 'by-hand');
  await fs.mkdir(extra);
  const added = await runner.addFolder(extra);
  assert.deepEqual([added.ok, added.name], [true, 'by-hand']);
  assert.deepEqual(names(await runner.listProjects()), ['alpha', 'beta', 'by-hand', 'gamma']);
});
