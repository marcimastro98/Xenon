// tools/display-sleep-check: what one screens-off / screens-on cycle counts as a trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, parseArgs, findingOf, liveKernelCode, dumpTimeOf, newReports, cycleResult, summary, acIndexOf, screenStates, wentOff } from '../../tools/display-sleep-check/lib.mjs';

test('options take whole numbers in range and refuse the rest', () => {
  assert.deepEqual(parseArgs([]), { ...DEFAULTS, out: '' });
  assert.deepEqual(parseArgs(['--cycles', '3', '--off', '30', '--settle', '5', '--out', 'x']), { cycles: 3, offSeconds: 30, settleSeconds: 5, idle: false, out: 'x' });
  assert.equal(parseArgs(['--idle', '--cycles', '2']).idle, true);
  assert.throws(() => parseArgs(['--cycles', '0']), /whole number/);
  assert.throws(() => parseArgs(['--off', '2.5']), /whole number/);
  assert.throws(() => parseArgs(['--loud']), /unknown option/);
});

test('a display driver reset is a trace, wherever Windows logs it', () => {
  assert.equal(findingOf({ log: 'System', id: 4101, provider: 'Display', message: 'Display driver nvlddmkm stopped responding\nmore' }).kind, 'tdr');
  const wer = 'Fault bucket LKD_0x117_Tdr, type 0\nEvent Name: LiveKernelEvent\nP1: 117\nP2: ffff';
  assert.deepEqual(findingOf({ log: 'Application', id: 1001, provider: 'Windows Error Reporting', message: wer }),
    { kind: 'live-kernel', code: '117', dumpAt: null, text: 'display driver timed out and was reset (TDR)' });
  assert.equal(findingOf({ log: 'System', id: 41, provider: 'Microsoft-Windows-Kernel-Power', message: 'rebooted' }).kind, 'crash');
});

test('events that say nothing about the screens are not traces', () => {
  assert.equal(findingOf({ log: 'Application', id: 1001, provider: 'Windows Error Reporting', message: 'Event Name: APPCRASH' }), null);
  assert.equal(findingOf({ log: 'System', id: 1001, provider: 'Microsoft-Windows-Something', message: 'x' }), null);
  assert.equal(findingOf(null), null);
});

test('the live kernel code reads the P1 field', () => {
  assert.equal(liveKernelCode('P1: 0193\r\nP2: 0'), '193');
  assert.equal(liveKernelCode('P1: 141'), '141');
  assert.equal(liveKernelCode('nothing here'), null);
});

test('only dumps that appeared or changed are new', () => {
  const a = { path: 'C:\\W\\LiveKernelReports\\WATCHDOG\\a.dmp', size: 10, at: '1' };
  const b = { path: 'C:\\W\\LiveKernelReports\\WATCHDOG\\b.dmp', size: 20, at: '2' };
  assert.deepEqual(newReports([a], [a, b]), [b]);
  assert.deepEqual(newReports([a], [{ ...a, size: 11 }]), [{ ...a, size: 11 }]);
  assert.deepEqual(newReports(undefined, [a]), [a]);
});

test('a cycle is clean only with no finding, no dump and no hung window', () => {
  assert.equal(cycleResult({}).ok, true);
  assert.equal(cycleResult({ events: [{ provider: 'check', message: 'could not read' }] }).ok, true, 'an unreadable log is reported, not a trace');
  assert.equal(cycleResult({ hung: ['42 Xenon'] }).ok, false);
  assert.equal(cycleResult({ reports: [{ path: 'x.dmp' }] }).ok, false);
  assert.equal(summary([{ ok: true }, { ok: false }]), '1 of 2 cycles left a trace');
  assert.equal(summary([{ ok: true }]), '1 cycles, nothing logged');
});

test('the Windows side posts the power message, never sends it', () => {
  const ps = fs.readFileSync(new URL('../../tools/display-sleep-check/power.ps1', import.meta.url), 'utf8');
  assert.match(ps, /PostMessage\(new IntPtr\(0xFFFF\), 0x0112, new IntPtr\(0xF170\), new IntPtr\(2\)\)/);
  assert.doesNotMatch(ps, /SendMessage\(/);
});

test('an old report Windows sends late is not a trace of this cycle', () => {
  const report = (stamp) => ({ log: 'Application', id: 1001, provider: 'Windows Error Reporting',
    message: `Nome evento: LiveKernelEvent\r\nP1: 141\r\nFile allegati:\r\nC:\\WINDOWS\\LiveKernelReports\\WATCHDOG\\WATCHDOG-${stamp}.dmp` });
  assert.equal(dumpTimeOf(report('20261114-1646').message), new Date(2026, 10, 14, 16, 46).getTime());
  assert.equal(dumpTimeOf('no dump'), null);
  const since = new Date(2026, 10, 15, 9, 30, 40).getTime();
  assert.equal(cycleResult({ events: [report('20261114-1646')], sinceMs: since }).ok, true, 'a reset from yesterday');
  assert.equal(cycleResult({ events: [report('20261115-0930')], sinceMs: since }).ok, false, 'same minute counts');
  assert.equal(cycleResult({ events: [report('20261115-0931')], sinceMs: since }).ok, false);
});

test('the display timeout on mains power is the second last value powercfg prints', () => {
  const out = 'Indice impostazione minimo possibile: 0x00000000\r\n  Indice impostazione massimo possibile: 0xffffffff\r\n' +
    '  Indice impostazione alimentazione CA corrente: 0x00000000\r\n  Indice impostazione alimentazione CC corrente: 0x00000258\r\n';
  assert.equal(acIndexOf(out), 0);
  assert.equal(acIndexOf('AC 0x0000003c DC 0x00000258'), 60);
  assert.throws(() => acIndexOf('Parametri non validi'), /no display timeout/);
});

test('the recorder tells whether the screens really went off in a cycle', () => {
  const states = screenStates('1000 1\r\n5000 0\n9000 1\nnoise\n12000 7\n');
  assert.deepEqual(states, [{ at: 1000, off: false }, { at: 5000, off: true }, { at: 9000, off: false }]);
  assert.equal(wentOff(states, 4000, 8000), true);
  assert.equal(wentOff(states, 6000, 8000), false, 'off before the cycle began');
  assert.equal(wentOff([], 0, 1e13), false);
});
