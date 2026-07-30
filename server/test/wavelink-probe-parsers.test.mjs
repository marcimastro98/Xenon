import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasklist, parseNetstatListening, parseLsofListening } from '../../tools/wavelink-probe.mjs';

// tools/wavelink-probe.mjs is what turns a "Wave Link won't connect" report into
// a measurement, so a parser of its own that quietly matches nothing would send
// us after the wrong cause with a straight face. The fixtures below are real
// output, captured verbatim, not invented shapes.

// `tasklist /fo csv /nh` on Windows 11.
const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"System","4","Services","0","160 K"',
  '"Secure System","236","Services","0","138.636 K"',
  '"WaveLink.exe","7788","Console","1","214.208 K"',
  '"Elgato Audio Driver.exe","9012","Console","1","12.004 K"',
  '"node.exe","22468","Console","1","98.120 K"',
].join('\r\n');

// `netstat -ano`, including the IPv6 spelling and the header Windows prints.
const NETSTAT = [
  '',
  'Connessioni attive',
  '',
  '  Proto  Indirizzo locale       Indirizzo esterno      Stato           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1452',
  '  TCP    0.0.0.0:3030           0.0.0.0:0              LISTENING       22468',
  '  TCP    127.0.0.1:1824         0.0.0.0:0              LISTENING       7788',
  '  TCP    127.0.0.1:52301        127.0.0.1:3030         ESTABLISHED     22468',
  '  TCP    [::]:135               [::]:0                 LISTENING       1452',
  '  TCP    [::1]:9010             [::]:0                 LISTENING       7788',
  '  UDP    0.0.0.0:5353           *:*                                    3120',
].join('\r\n');

test('tasklist rows become a pid to name map', () => {
  const byPid = parseTasklist(TASKLIST);
  assert.equal(byPid.get('7788'), 'WaveLink.exe');
  assert.equal(byPid.get('9012'), 'Elgato Audio Driver.exe');   // spaces in the name
  assert.equal(byPid.get('0'), 'System Idle Process');
  assert.equal(byPid.size, 6);
});

test('netstat yields only LISTENING TCP rows, IPv4 and IPv6 alike', () => {
  const rows = parseNetstatListening(NETSTAT);
  assert.deepEqual(rows, [
    { addr: '0.0.0.0:135', pid: '1452' },
    { addr: '0.0.0.0:3030', pid: '22468' },
    { addr: '127.0.0.1:1824', pid: '7788' },
    { addr: '[::]:135', pid: '1452' },
    { addr: '[::1]:9010', pid: '7788' },
  ]);
});

// The whole point of the section: an ESTABLISHED connection is not a listener,
// and counting one would report a port nothing can be reached on.
test('established connections and UDP are not listeners', () => {
  const addrs = parseNetstatListening(NETSTAT).map((r) => r.addr);
  assert.ok(!addrs.includes('127.0.0.1:52301'));
  assert.ok(!addrs.includes('0.0.0.0:5353'));
});

test('a Wave Link pid is joinable from netstat back to its name', () => {
  const byPid = parseTasklist(TASKLIST);
  const wl = parseNetstatListening(NETSTAT).filter((r) => /wave|elgato/i.test(byPid.get(r.pid) || ''));
  assert.deepEqual(wl.map((r) => r.addr), ['127.0.0.1:1824', '[::1]:9010']);
});

// `lsof -nP -iTCP -sTCP:LISTEN` on macOS.
const LSOF = [
  'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'WaveLink   1204 marce   21u  IPv4 0x9f2a1b3c4d5e6f70      0t0  TCP 127.0.0.1:1824 (LISTEN)',
  'node      22468 marce   19u  IPv6 0x1122334455667788      0t0  TCP *:3030 (LISTEN)',
].join('\n');

test('lsof rows carry command, pid and address', () => {
  const rows = parseLsofListening(LSOF);
  assert.deepEqual(rows, [
    { name: 'WaveLink', pid: '1204', addr: '127.0.0.1:1824' },
    { name: 'node', pid: '22468', addr: '*:3030' },
  ]);
  // The header must not survive as a row — it would read as a process named
  // COMMAND listening on nothing.
  assert.ok(!rows.some((r) => r.name === 'COMMAND'));
});

test('empty or garbage input yields nothing rather than throwing', () => {
  for (const bad of ['', '\n\n', 'not output at all']) {
    assert.deepEqual(parseNetstatListening(bad), []);
    assert.deepEqual(parseLsofListening(bad), []);
    assert.equal(parseTasklist(bad).size, 0);
  }
});
