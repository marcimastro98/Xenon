'use strict';
// Reads what each system says about a sign-in and about the entries that start programs with
// it. Text in, values out: nothing here asks the system anything.

const path = require('node:path');

// A FILETIME counts 100 ns steps from 1601; JavaScript counts milliseconds from 1970.
const FILETIME_STEPS_PER_MS = 10000n;
const FILETIME_TO_UNIX_MS = 11644473600000n;

/** @param {bigint} filetime @returns {number} the same moment in milliseconds since 1970 */
function filetimeToMs(filetime) {
  return Number(BigInt(filetime) / FILETIME_STEPS_PER_MS - FILETIME_TO_UNIX_MS);
}

// ── Windows: the Run list ────────────────────────────────────────────────────

/** The text of one value in what `reg query <key> /v <name>` prints, '' when it is not there. */
function regValue(output, name, type) {
  const line = new RegExp('^\\s+' + name + '\\s+' + type + '\\s+(.*)$', 'im').exec(String(output || ''));
  return line ? line[1].trim() : '';
}

/** @returns {string} the command line the Run list starts under `name`, '' when there is none */
function runEntry(output, name) {
  return regValue(output, name, 'REG_(?:EXPAND_)?SZ');
}

/**
 * Task Manager's "Startup apps" switch, kept beside the Run list: the first byte is odd
 * (3 or 7) when the user turned the entry off. No value means nobody touched it.
 * @returns {boolean}
 */
function runEntryOff(output, name) {
  const first = Number.parseInt(regValue(output, name, 'REG_BINARY').slice(0, 2), 16);
  return Number.isInteger(first) && first % 2 === 1;
}

/**
 * The program a Run command line starts. The line is quoted by current versions of the app
 * and was written bare by older ones, spaces in the path included, so a bare line is read up
 * to its first `.exe`.
 * @returns {string} '' when the line names no program
 */
function commandProgram(command) {
  const text = String(command || '').trim();
  const quoted = /^"([^"]+)"/.exec(text);
  if (quoted) return quoted[1];
  const bare = /^(.*?\.exe)(?:\s|$)/i.exec(text);
  return bare ? bare[1] : '';
}

/** @returns {boolean} whether `program` is the file `exe`, by full Windows path */
function isProgram(program, exe) {
  const win = path.win32;
  return !!program && win.isAbsolute(program) && win.basename(program).toLowerCase() === exe;
}

// ── macOS ────────────────────────────────────────────────────────────────────

/** `sysctl -n kern.boottime` prints `{ sec = 1700000000, usec = 0 } ...`. @returns {string} the seconds, '' when unread */
function bootSeconds(output) {
  const found = /\bsec\s*=\s*(\d+)/.exec(String(output || ''));
  return found ? found[1] : '';
}

// ── Linux ────────────────────────────────────────────────────────────────────

/** @returns {boolean} whether /proc/self/cgroup places this process in the systemd unit `unit` */
function inUnit(cgroup, unit) {
  return String(cgroup || '').split('\n').some((line) => line.split('/').pop() === unit);
}

/**
 * When a process started, from its /proc/<pid>/stat: field 22, in clock ticks since boot.
 * The name of the program is the second field and may hold spaces and brackets, so the
 * fields are counted from the last closing bracket.
 * @returns {string} '' when the text is not a stat line
 */
function procStartTicks(stat) {
  const text = String(stat || '');
  const after = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  const ticks = after[19];
  return text.includes(')') && /^\d+$/.test(ticks || '') ? ticks : '';
}

/** @returns {boolean} whether a desktop entry is switched off (`Hidden=true`), as desktops do instead of deleting it */
function desktopEntryOff(text) {
  return /^\s*Hidden\s*=\s*true\s*$/im.test(String(text || ''));
}

module.exports = {
  filetimeToMs, runEntry, runEntryOff, commandProgram, isProgram, bootSeconds, inUnit, procStartTicks, desktopEntryOff,
};
