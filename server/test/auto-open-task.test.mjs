// The old "Xenon Edge Dashboard" task, and what becomes of it.
//
// Up to 5.1.0 the switch "open the dashboard in the browser at sign-in" registered a
// scheduled task that ran a small script, and the script opened the tab. Antivirus software
// deleted the script, Windows then showed "Can not find script file" at every sign-in, and
// the switch was hidden. The engine opens the tab itself now (sign-in-open.test.mjs), so the
// task has one thing left to do: tell the engine, once, that this person had the switch on,
// and go. Nothing registers it again. The scheduler is a stand-in here: no task on the
// computer running the test is read, changed or removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFile } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { retireBrowserTask, BROWSER_TASK_NAME } = require('../install/browser-auto-open-task.js');

const SRC = engineSource().replace(/\r\n/g, '\n');
const MODULE = readFile(new URL('../install/browser-auto-open-task.js', import.meta.url), 'utf8');

/** A scheduler that holds the old task or does not, and records what it was asked. */
function scheduler({ task = true, deleteFails = false, armFails = false } = {}) {
  const did = [];
  const run = async (args, opts) => {
    did.push(args.join(' '));
    assert.ok(opts && opts.timeout > 0, 'a scheduler that hangs must not hang the engine');
    if (args[0] === '/Query' && !task) throw new Error('ERROR: The system cannot find the file specified.');
    if (args[0] === '/Delete' && deleteFails) throw new Error('ERROR: Access is denied.');
    return { stdout: '' };
  };
  const arm = async () => {
    did.push('arm');
    if (armFails) throw new Error('settings could not be saved');
    return true;
  };
  return { did, deps: { platform: 'win32', port: 3030, run, arm } };
}

test('the task is the old one, by its exact name', () => {
  assert.equal(BROWSER_TASK_NAME, 'Xenon Edge Dashboard');
});

test('no old task: nothing is switched on and nothing is deleted', async () => {
  const pc = scheduler({ task: false });
  assert.equal(await retireBrowserTask(pc.deps), 'no_task');
  assert.deepEqual(pc.did, ['/Query /TN Xenon Edge Dashboard']);
});

test('an old task means this person had the switch on: that is kept, then the task goes', async () => {
  const pc = scheduler();
  assert.equal(await retireBrowserTask(pc.deps), 'removed');
  assert.deepEqual(pc.did, [
    '/Query /TN Xenon Edge Dashboard',
    'arm',
    '/Delete /TN Xenon Edge Dashboard /F',
  ], 'kept first, deleted after: the task is the only trace of the choice');
});

test('when the choice cannot be saved the task stays, to be read again at the next start', async () => {
  const pc = scheduler({ armFails: true });
  assert.equal(await retireBrowserTask(pc.deps), 'kept');
  assert.deepEqual(pc.did, ['/Query /TN Xenon Edge Dashboard', 'arm'], 'nothing is deleted');
});

test('a task that cannot be deleted is tried again at the next start, and the choice is kept meanwhile', async () => {
  const pc = scheduler({ deleteFails: true });
  assert.equal(await retireBrowserTask(pc.deps), 'kept');
  assert.ok(pc.did.includes('arm'));
  // The next start: the task is still there, so it is read and removed then.
  const next = scheduler();
  assert.equal(await retireBrowserTask(next.deps), 'removed');
});

test('each argument reaches the scheduler as its own item, the name with its spaces whole', async () => {
  const seen = [];
  const run = async (args) => { seen.push(args); return {}; };
  await retireBrowserTask({ platform: 'win32', port: 3030, run, arm: async () => true });
  assert.deepEqual(seen, [
    ['/Query', '/TN', 'Xenon Edge Dashboard'],
    ['/Delete', '/TN', 'Xenon Edge Dashboard', '/F'],
  ]);
});

test('a copy beside the installed engine never touches the installed engine task', async () => {
  for (const port of [3031, 3039, 3043, 3050]) {
    const pc = scheduler();
    assert.equal(await retireBrowserTask({ ...pc.deps, port }), 'not_here');
    assert.deepEqual(pc.did, [], 'port ' + port);
  }
});

test('macOS and Linux never had the task and are never asked about it', async () => {
  for (const platform of ['darwin', 'linux']) {
    const pc = scheduler();
    assert.equal(await retireBrowserTask({ ...pc.deps, platform }), 'not_here');
    assert.deepEqual(pc.did, []);
  }
});

test('the clean-up runs a minute after every start, with the other leftovers', () => {
  assert.match(SRC, /setTimeout\(tidyLeftoverTasks, LEFTOVER_TASKS_DELAY_MS\)\.unref\(\);/,
    'the tidy-up must be scheduled from the listen callback');
  assert.match(SRC, /function tidyLeftoverTasks\(\) \{[\s\S]{0,600}reconcileBrowserAutoOpenTask\(\)\.catch\(\(\) => \{\}\);/);
});

test('nothing in the engine registers the task or names its script any more', () => {
  assert.doesNotMatch(MODULE, /\/Create|\/Change|wscript|\.vbs/, 'the task is only ever read and deleted');
  for (const gone of ['open-dashboard.vbs', 'launcher_missing', 'setBrowserAutoOpen', 'autoOpenTaskFix']) {
    assert.ok(!SRC.includes(gone), gone + ' is back in the engine');
  }
  // Every scheduler call that names the task, in the whole engine: a read and a delete.
  const calls = [...SRC.matchAll(/\['\/(\w+)', '\/TN', BROWSER_TASK_NAME/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['Query', 'Delete']);
});

test('the tab of this start is decided when the engine listens, before the old task is read', () => {
  // So the first start after the update opens nothing even for someone who had the task:
  // that start is the update, not a sign-in. Their tab comes back with the next sign-in.
  const listen = SRC.indexOf('setTimeout(tidyLeftoverTasks, LEFTOVER_TASKS_DELAY_MS)');
  const decide = SRC.indexOf("require('./install/sign-in-open.js').openDashboardAtSignIn({ port: PORT })");
  assert.ok(listen > 0 && decide > listen && decide - listen < 400, 'both in the listen callback, the decision not delayed');
});
