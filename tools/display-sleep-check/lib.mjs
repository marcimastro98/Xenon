// tools/display-sleep-check: the rules that read what Windows logged around one
// screens-off / screens-on cycle. Pure, so the test runs anywhere.

export const DEFAULTS = Object.freeze({ cycles: 5, offSeconds: 90, settleSeconds: 20, idle: false });

// The display timeout the idle mode sets, in seconds: the shortest Windows offers.
export const IDLE_TIMEOUT_S = 60;

// Live kernel event codes worth naming: the P1 of a "LiveKernelEvent" report, in hex.
const LIVE_KERNEL = Object.freeze({
  117: 'display driver timed out and was reset (TDR)',
  141: 'display engine stopped answering (TDR)',
  193: 'display kernel took a live dump',
});

export function parseArgs(argv) {
  const out = { ...DEFAULTS, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--idle') { out.idle = true; continue; }
    if (key === '--cycles') out.cycles = positiveInt(value, key);
    else if (key === '--off') out.offSeconds = positiveInt(value, key);
    else if (key === '--settle') out.settleSeconds = positiveInt(value, key);
    else if (key === '--out') out.out = String(value || '');
    else throw new Error(`unknown option ${key}`);
    i++;
  }
  return out;
}

function positiveInt(value, key) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3600) throw new Error(`${key} needs a whole number from 1 to 3600`);
  return n;
}

// One logged event as a finding, or null when it says nothing about the screens.
export function findingOf(event) {
  const { log, id, provider = '', message = '' } = event || {};
  if (provider === 'check') return { kind: 'unreadable', text: message };
  if (log === 'System' && id === 4101) return { kind: 'tdr', text: firstLine(message) };
  if (log === 'System' && (id === 41 || id === 6008)) return { kind: 'crash', text: firstLine(message) };
  if (log === 'System' && id === 1001 && /BugCheck/i.test(provider)) return { kind: 'crash', text: firstLine(message) };
  if (log === 'Application' && id === 1001 && /LiveKernelEvent/.test(message)) {
    const code = liveKernelCode(message);
    return { kind: 'live-kernel', code, dumpAt: dumpTimeOf(message), text: LIVE_KERNEL[code] || `live kernel event ${code ?? '?'}` };
  }
  return null;
}

// The code of a LiveKernelEvent report: "P1: 117" in the WER text.
export function liveKernelCode(message) {
  const match = /P1:\s*([0-9a-f]+)/i.exec(String(message));
  return match ? match[1].toLowerCase().replace(/^0+(?=.)/, '') : null;
}

// When the dump of a report was written, from its name (WATCHDOG-20261114-1646.dmp,
// local time): Windows sends old reports in batches, so the event's own time can be
// days after the reset it describes. Null when the report names no dump.
export function dumpTimeOf(message) {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.dmp/i.exec(String(message));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}

const firstLine = (text) => String(text).split(/\r?\n/)[0].slice(0, 200);

// Dump files that appeared or changed between two listings.
export function newReports(before, after) {
  const seen = new Set((before || []).map((f) => `${f.path}|${f.size}|${f.at}`));
  return (after || []).filter((f) => !seen.has(`${f.path}|${f.size}|${f.at}`));
}

// What one cycle found: findings, new dumps, windows that stopped answering.
// A report whose dump is older than the cycle (to the minute the name keeps) is an
// old one sent late and does not count.
export function cycleResult({ events = [], reports = [], hung = [], sinceMs = 0 }) {
  const fromMinute = Math.floor(sinceMs / 60000) * 60000;
  const findings = events.map(findingOf).filter((f) => f && !(f.dumpAt != null && f.dumpAt < fromMinute));
  const bad = findings.some((f) => f.kind !== 'unreadable') || reports.length > 0 || hung.length > 0;
  return { ok: !bad, findings, reports: reports.map((r) => r.path), hung };
}

export function summary(results) {
  const failed = results.filter((r) => !r.ok).length;
  if (!results.length) return 'no cycle ran';
  return failed ? `${failed} of ${results.length} cycles left a trace` : `${results.length} cycles, nothing logged`;
}

// The display timeout on mains power, in seconds, from `powercfg /q ... VIDEOIDLE`:
// its last two hex values are the AC then the DC index (the labels are translated).
export function acIndexOf(output) {
  const values = String(output).match(/0x[0-9a-f]{8}/gi) || [];
  if (values.length < 2) throw new Error('powercfg gave no display timeout');
  return parseInt(values[values.length - 2], 16);
}

// The screens' states Windows announced, from the recorder's "<ms> <state>" lines.
export function screenStates(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([at, state]) => Number.isFinite(at) && [0, 1, 2].includes(state))
    .map(([at, state]) => ({ at, off: state === 0 }));
}

// Whether Windows really switched the screens off between two moments.
export function wentOff(states, fromMs, toMs) {
  return states.some((s) => s.off && s.at >= fromMs && s.at <= toMs);
}
