// Whether Xenon will still be here after the next sign-in.
//
// On Windows the engine is started by a per-logon scheduled task. Three of its
// settings are choices install.ps1 makes deliberately — start on battery, don't
// stop on battery, no execution time limit — and each already has a bug report
// behind it. install.ps1 checks them once, at install time. Nothing looked
// again, and nothing ever told the user.
//
// Reported on Discord by someone whose engine kept being stopped: "something
// keeps disabling the requirements in task scheduler". From the dashboard that
// is invisible — what he saw was features that had stopped working, and he spent
// days reporting those instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const st = require('../startup-task.js');

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const UPDATE = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** A task definition in the shape schtasks /Query /XML actually emits. */
function taskXml({ triggerEnabled = 'true', settings = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>${triggerEnabled}</Enabled>
      <UserId>PC\\user</UserId>
    </LogonTrigger>
  </Triggers>
  <Settings>
${settings}
  </Settings>
</Task>`;
}

const HEALTHY = taskXml({ settings: [
  '    <Enabled>true</Enabled>',
  '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
  '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
  '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
].join('\n') });

test('a task registered the way the installer registers it is healthy', () => {
  assert.deepEqual(st.taskProblems(st.parseTaskXml(HEALTHY)), []);
});

// The reported case: something put the Task Scheduler defaults back.
test('the defaults something keeps restoring are all named', () => {
  const xml = taskXml({ settings: [
    '    <Enabled>true</Enabled>',
    '    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>',
  ].join('\n') });
  assert.deepEqual(st.taskProblems(st.parseTaskXml(xml)),
    ['no_battery_start', 'stops_on_battery', 'time_limited']);
});

// An omitted flag is not an unknown: Task Scheduler's default for each of these
// is the broken value, so reading absence as "fine" would report exactly the
// task this exists to catch as healthy.
test('a setting left out of the XML counts as the default, not as unknown', () => {
  const problems = st.taskProblems(st.parseTaskXml(taskXml({ settings: '    <Enabled>true</Enabled>' })));
  assert.deepEqual(problems, ['no_battery_start', 'stops_on_battery', 'time_limited']);
});

// <Enabled> appears once per trigger and once in <Settings>. Reading the first
// match would report the logon trigger's state as the task's.
test('the task being off is not confused with the trigger being off', () => {
  const off = taskXml({ triggerEnabled: 'true', settings: [
    '    <Enabled>false</Enabled>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
  ].join('\n') });
  assert.deepEqual(st.taskProblems(st.parseTaskXml(off)), ['disabled']);
  // …and the inverse: a disabled TRIGGER must not make a live task read as off.
  const trig = taskXml({ triggerEnabled: 'false', settings: [
    '    <Enabled>true</Enabled>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
  ].join('\n') });
  assert.deepEqual(st.taskProblems(st.parseTaskXml(trig)), []);
});

test('the repair puts the three conditions back and touches nothing else', () => {
  const broken = taskXml({ settings: [
    '    <Enabled>false</Enabled>',
    '    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>',
  ].join('\n') });
  const fixed = st.repairTaskXml(broken);
  assert.deepEqual(st.taskProblems(st.parseTaskXml(fixed)), ['disabled'],
    'the conditions are repaired and `disabled` deliberately is not');
  // Turning the task back on is the user's call — Task Manager offers them that
  // switch, and flipping it behind them would be overriding a real choice.
  assert.match(fixed, /<Enabled>false<\/Enabled>\s*\n\s*<DisallowStartIfOnBatteries>/,
    'the Settings Enabled flag is left exactly as found');
  assert.match(fixed, /<LogonTrigger>[\s\S]*<UserId>PC\\user<\/UserId>/, 'the rest of the task survives');
});

// A flag Task Scheduler omitted still has to be repaired, which means writing a
// tag that was never there.
test('a missing condition is added, not skipped', () => {
  const fixed = st.repairTaskXml(taskXml({ settings: '    <Enabled>true</Enabled>' }));
  assert.deepEqual(st.taskProblems(st.parseTaskXml(fixed)), []);
});

// schtasks emits UTF-16LE with a BOM. Read as utf8 it becomes a string with a
// NUL between every character — which every check above would miss while
// throwing nothing: the worst possible shape for a check whose job is noticing.
test('the UTF-16 output schtasks actually produces is decoded', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(HEALTHY, 'utf16le')]);
  assert.deepEqual(st.taskProblems(st.parseTaskXml(st.decodeSchtasksOutput(buf))), []);
  assert.equal(st.decodeSchtasksOutput(Buffer.from('plain')), 'plain');
  assert.equal(st.decodeSchtasksOutput(Buffer.alloc(0)), '');
});

test('anything that is not a task definition is "nothing to say", not a crash', () => {
  assert.equal(st.parseTaskXml(''), null);
  assert.equal(st.parseTaskXml('ERROR: The system cannot find the file specified.'), null);
  assert.deepEqual(st.taskProblems(null), []);
});

test('off Windows nothing is checked and nothing is claimed', async () => {
  const res = await st.checkStartupTask({});
  if (process.platform === 'win32') return;   // the real check belongs to the machine it runs on
  assert.deepEqual(res, { checked: false, found: false, problems: [], repaired: [], failed: '' });
});

// The engine is running while this is checkable, which is what makes it the one
// thing in a position to notice — but only if it looks more than once.
test('the engine looks at boot and keeps looking', () => {
  assert.match(SERVER, /refreshStartupTaskState\(\)\.catch\(\(\) => \{\}\);/, 'checked at boot');
  assert.match(SERVER, /setInterval\(\(\) => \{ refreshStartupTaskState\(\)\.catch\(\(\) => \{\}\); \}, STARTUP_TASK_CHECK_MS\)\.unref\(\)/,
    'and again later — the task can be switched off while Xenon runs');
  const fn = SERVER.slice(SERVER.indexOf('async function refreshStartupTaskState()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /is switched OFF/, 'a task that is off reaches the log');
  assert.match(body, /put back ' \+ res\.repaired\.join/, 'so does a repair this app made on its own');
});

test('the dashboard says the two things worth saying, and nothing on a healthy install', () => {
  const fn = UPDATE.slice(UPDATE.indexOf('async function surfaceStartupTaskNotice()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(!st \|\| !st\.ok \|\| !st\.found/, 'silent when there is no task to talk about');
  assert.match(body, /duration: 0,/, 'the "will not start" notice is sticky');
  assert.match(body, /startup_task_off_title/);
  assert.match(body, /startup_task_fixed_title/);
  assert.match(UPDATE, /surfaceStartupTaskNotice\(\);/, 'and it actually runs at boot');
});

test('both notices exist in every language the app ships', () => {
  for (const key of ['startup_task_off_title', 'startup_task_off_msg',
    'startup_task_fixed_title', 'startup_task_fixed_msg']) {
    const found = new Set();
    let current = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) current = ns[1];
      const t = line.trimStart();
      if (t.startsWith(key + ':') || t.startsWith('"' + key + '":')) found.add(current);
    }
    const missing = LANGS.filter((l) => !found.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});
