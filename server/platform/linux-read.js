'use strict';
// The small tools every Linux reader uses: run a command, read a text file, split lines, tell a
// number, do several things a few at a time.

const { execFile } = require('node:child_process');
const fsp = require('node:fs').promises;

// Promise wrapper around execFile with a hard timeout; resolves stdout.
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());

// Split on LF or CRLF. Worth being explicit about why: `\r` counts as a line
// terminator in JS regex, so `.` does not match it, and a pattern anchored with
// `$` fails on a CRLF line entirely instead of merely capturing a trailing
// character. These parsers read tool output on Linux, but the fixtures behind
// them are files that a Windows checkout can convert, so the parsers accept both.
const splitLines = (text) => String(text || '').split(/\r?\n/);

// Run an async mapper over items with at most `limit` in flight. Promise.all on
// a whole window list forks that many processes at once; a desktop with many
// windows would spike to one xprop per window in a single tick.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- CPU temperature and fans: /sys/class/hwmon ------------------------------
// Returns { cpuTemp: number|null, fans: [{name, rpm, kind}] } to match the shape
// CPU_TEMP_SCRIPT produces on Windows.
//
// Fans need no LibreHardwareMonitor and no elevation here: any chip with a
// tachometer publishes `fanN_input` in RPM as a world-readable file. That is the
// whole feature on this platform, which is why the widget's "install the
// companion / re-run INSTALL.bat" hint was doubly wrong on Linux — it named a
// Windows dependency and a Windows installer for something the kernel already
// had. Coverage is per-driver: laptops with `thinkpad`/`dell_smm`/`applesmc`
// report, most desktops report through `nct6775` and friends once lm_sensors has
// loaded the right module, and a machine whose chip has no driver reports
// nothing — which is then genuinely nothing, not a missing tool.
const readText = async (p) => (await fsp.readFile(p, 'utf8')).trim();

module.exports = { run, isNum, splitLines, mapLimit, readText };
