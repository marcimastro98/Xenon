'use strict';
// ── Does Xenon still start when you sign in? ─────────────────────────────────
//
// On Windows the engine is started by a per-logon scheduled task, "Xenon Edge
// Widget", registered by install.ps1. Three of that task's settings are not
// defaults we accept — they are choices the installer makes on purpose, and each
// one has already produced a bug report:
//
//   • DisallowStartIfOnBatteries / StopIfGoingOnBatteries. Task Scheduler turns
//     BOTH on unless told otherwise, so every laptop install once refused to
//     start Xenon on battery and killed it the moment the charger came out. A
//     dashboard that disappears when you unplug reads as a crash.
//   • ExecutionTimeLimit. The default is three days, after which Windows stops
//     the task — a backend that is meant to run all day, ended by a stopwatch.
//   • Enabled. Task Manager's Startup apps tab, cleanup utilities and antivirus
//     software all switch tasks off; observed in the wild in Aug 2026 on a
//     machine where nobody had touched it.
//
// install.ps1 sets all of them, and checks them — once, at install time. Nothing
// checked afterwards, and nothing ever told the user. Reported on Discord by
// someone whose engine kept stopping: "something keeps disabling the
// requirements in task scheduler". From the dashboard that is invisible; what he
// saw instead was features that had stopped working, and he spent days reporting
// those. The engine is running while this is checkable, which makes it the one
// thing in a position to notice.
//
// The three CONDITIONS are ours, so finding them changed means something else
// changed them and they are put back. `Enabled` is NOT: that switch is offered
// to the user in Task Manager, and turning it back on behind them would be
// overriding a choice they are allowed to make. It is reported instead.
//
// The XML round-trip (query → patch → re-register) is deliberate: it keeps every
// other property of the task exactly as registered, needs no PowerShell engine,
// and leaves the patch as a pure function this can be tested through.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NAME = 'Xenon Edge Widget';
// Task Scheduler's XML spelling for "no limit". Same value New-ScheduledTaskSettingsSet
// writes for -ExecutionTimeLimit ([TimeSpan]::Zero), so a repaired task and a
// freshly installed one are byte-identical here.
const NO_TIME_LIMIT = 'PT0S';

// `<Enabled>` appears TWICE in a task definition — once per trigger, once in
// <Settings> — and they mean different things. Reading the first match would
// report the logon trigger's state as the task's, which is how a disabled task
// could look healthy. Cut the Settings block out first.
function settingsBlock(xml) {
  const src = String(xml || '');
  const open = src.indexOf('<Settings>');
  if (open === -1) return '';
  const close = src.indexOf('</Settings>', open);
  return close === -1 ? '' : src.slice(open, close + '</Settings>'.length);
}

function tagValue(block, tag) {
  const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(block);
  return m ? m[1].trim() : '';
}

/** What the task currently says about itself. Pure. */
function parseTaskXml(xml) {
  const block = settingsBlock(xml);
  if (!block) return null;                       // not a task definition we understand
  const limit = tagValue(block, 'ExecutionTimeLimit');
  return {
    // Absent means the Task Scheduler default, which is `true` for Enabled and
    // for both battery flags — so an absent flag is a REAL condition, not an
    // unknown. Defaulting them the other way would report a broken task healthy.
    enabled: tagValue(block, 'Enabled') !== 'false',
    startsOnBattery: tagValue(block, 'DisallowStartIfOnBatteries') === 'false',
    stopsOnBattery: tagValue(block, 'StopIfGoingOnBatteries') !== 'false',
    timeLimit: limit || 'PT72H',
  };
}

/** Problem codes, most consequential first. Pure. */
function taskProblems(state) {
  if (!state) return [];
  const out = [];
  if (!state.enabled) out.push('disabled');
  if (!state.startsOnBattery) out.push('no_battery_start');
  if (state.stopsOnBattery) out.push('stops_on_battery');
  if (state.timeLimit && state.timeLimit !== NO_TIME_LIMIT) out.push('time_limited');
  return out;
}

/** The three conditions this app owns. `disabled` is the user's, never ours. */
const REPAIRABLE = Object.freeze(['no_battery_start', 'stops_on_battery', 'time_limited']);

// Set a tag inside the Settings block only, adding it when Task Scheduler left
// it out (an omitted flag carries the default, which is the value we are fixing).
function _setInSettings(xml, tag, value) {
  const block = settingsBlock(xml);
  if (!block) return xml;
  const re = new RegExp('<' + tag + '>[^<]*</' + tag + '>');
  const next = re.test(block)
    ? block.replace(re, '<' + tag + '>' + value + '</' + tag + '>')
    : block.replace('</Settings>', '  <' + tag + '>' + value + '</' + tag + '>\n</Settings>');
  return xml.replace(block, next);
}

/** Put the three conditions back, leaving everything else — Enabled included. Pure. */
function repairTaskXml(xml) {
  let out = String(xml || '');
  out = _setInSettings(out, 'DisallowStartIfOnBatteries', 'false');
  out = _setInSettings(out, 'StopIfGoingOnBatteries', 'false');
  out = _setInSettings(out, 'ExecutionTimeLimit', NO_TIME_LIMIT);
  return out;
}

// schtasks writes its XML as UTF-16LE with a BOM. Read it as bytes and decode by
// the BOM: taking it as utf8 yields a string with a NUL between every character,
// which every regex above would miss without failing — the worst shape for a
// check whose whole job is to notice something.
function decodeSchtasksOutput(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

function run(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true, maxBuffer: 1024 * 1024, ...(opts || {}) },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function readTaskXml() {
  const out = await run(['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], { encoding: 'buffer' });
  return decodeSchtasksOutput(out);
}

/**
 * Look at the startup task and put back what is ours to put back.
 * Answers { checked, found, problems, repaired, failed } — never throws, never
 * runs off Windows, and a machine with no such task (a dev checkout, a portable
 * run, the native app on another platform) is simply `found: false`.
 */
async function checkStartupTask({ dataDir, repair = true } = {}) {
  const answer = { checked: false, found: false, problems: [], repaired: [], failed: '' };
  if (process.platform !== 'win32') return answer;
  answer.checked = true;
  let xml = '';
  try { xml = await readTaskXml(); } catch { return answer; }   // no task registered
  const state = parseTaskXml(xml);
  if (!state) return answer;
  answer.found = true;
  answer.problems = taskProblems(state);
  const fixable = answer.problems.filter((p) => REPAIRABLE.includes(p));
  if (!repair || !fixable.length) return answer;

  const tmp = path.join(dataDir || os.tmpdir(), 'startup-task.repair.xml');
  try {
    // UTF-16LE with a BOM: what schtasks emits, and the only encoding its
    // /Create importer reads back without mangling a non-ASCII install path.
    fs.writeFileSync(tmp, '﻿' + repairTaskXml(xml), 'utf16le');
    await run(['/Create', '/XML', tmp, '/TN', TASK_NAME, '/F']);
    answer.repaired = fixable;
  } catch (e) {
    answer.failed = (e && e.message) ? e.message : String(e);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  }
  return answer;
}

module.exports = {
  TASK_NAME, NO_TIME_LIMIT, REPAIRABLE,
  parseTaskXml, taskProblems, repairTaskXml, decodeSchtasksOutput, checkStartupTask,
};
