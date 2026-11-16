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

// ── Windows: the scheduler's list ────────────────────────────────────────────

/**
 * Whether `schtasks /Query /FO CSV /NH` lists a task of this name in the scheduler's top
 * folder. Each line begins with the task's full name in quotes; the columns after it are in
 * the language of Windows and are not read.
 * @returns {boolean}
 */
function taskListed(csv, name) {
  const first = '"\\' + String(name).toLowerCase() + '",';
  return String(csv || '').split(/\r?\n/).some((line) => line.toLowerCase().startsWith(first));
}

// ── Windows: the Run list ────────────────────────────────────────────────────

/**
 * Whether what `reg query <parent of key>` prints lists `key` under it. reg ends with the
 * same code for a key that is not there and for one it could not read, and says which in the
 * language of Windows; the parent's list tells the two apart in any language.
 * @param {string} output @param {string} key the whole key, e.g. HKCU\Software\Example\Run
 * @returns {boolean}
 */
function subkeyListed(output, key) {
  // reg spells the root out (HKEY_CURRENT_USER for HKCU), so the path below it is compared.
  const end = '\\' + String(key).split('\\').slice(1).join('\\').toLowerCase();
  return String(output || '').split(/\r?\n/).some((line) => /^HKEY_/.test(line) && line.trimEnd().toLowerCase().endsWith(end));
}

/** The text of one value in what `reg query <key>` prints for the key, '' when the key does not hold it. */
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

/**
 * `sysctl -n kern.bootsessionuuid` prints one UUID, made new each time the Mac boots. Unlike
 * the time of the boot, it stays the same when the clock is set.
 * @returns {string} the UUID in lower case, '' when the text is not one
 */
function bootSession(output) {
  const found = /^\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/i.exec(String(output || ''));
  return found ? found[1].toLowerCase() : '';
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

// /proc counts the start of a process in clock ticks, 100 to the second on every Linux (USER_HZ).
const TICK_MS = 10;

/** @returns {number} how long after `earlier` the process `later` started, both as procStartTicks reads them; NaN when either is unread */
function ticksBetweenMs(earlier, later) {
  return earlier && later ? (Number(later) - Number(earlier)) * TICK_MS : Number.NaN;
}

// What a program needs to reach the desktop of the session, and the shape each value must
// have to be handed on. A path may hold any letter but no control character, quote, dollar or
// backslash: systemd prints a value it had to escape as $'...', and that is never passed on.
const PATH_VALUE = /^\/[^\p{Cc}'"$\\]*$/u;
const SESSION_VARS = Object.freeze({
  DISPLAY: /^[\w.\-[\]:]*:\d{1,4}(?:\.\d{1,2})?$/,
  WAYLAND_DISPLAY: /^[\w.\-/]+$/,
  XAUTHORITY: PATH_VALUE,
  XDG_RUNTIME_DIR: PATH_VALUE,
  DBUS_SESSION_BUS_ADDRESS: /^[\w.\-:=,;/%@+]+$/,
  XDG_CURRENT_DESKTOP: /^[\w\-:]+$/,
});
const MAX_VALUE_LENGTH = 1024;

/**
 * The session's variables out of what `systemctl --user show-environment` prints (one
 * NAME=value a line): only the names above, each only in its plain shape.
 * @returns {Record<string, string>}
 */
function sessionEnv(output) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    const name = line.slice(0, Math.max(at, 0));
    const value = line.slice(at + 1);
    if (Object.hasOwn(SESSION_VARS, name) && value.length <= MAX_VALUE_LENGTH && SESSION_VARS[name].test(value)) env[name] = value;
  }
  return env;
}

/** @returns {boolean} whether these variables name a display a browser can open on */
function hasDisplay(env) {
  return !!(env && (env.DISPLAY || env.WAYLAND_DISPLAY));
}

/** @returns {boolean} whether a desktop entry is switched off (`Hidden=true`), as desktops do instead of deleting it */
function desktopEntryOff(text) {
  return /^\s*Hidden\s*=\s*true\s*$/im.test(String(text || ''));
}

module.exports = {
  filetimeToMs, taskListed, subkeyListed, runEntry, runEntryOff, commandProgram, isProgram, bootSession, inUnit, procStartTicks,
  ticksBetweenMs, sessionEnv, hasDisplay, desktopEntryOff,
};
