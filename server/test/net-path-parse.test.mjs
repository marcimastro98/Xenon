import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../net-path/parse.js');

// Every address here is invented: RFC 5737 documentation ranges and generic
// private examples.

test('IPv4 addresses round-trip through the number Windows takes', () => {
  assert.equal(P.ipv4ToInt('192.0.2.1'), 0x010200c0);
  assert.equal(P.intToIpv4(0x010200c0), '192.0.2.1');
  assert.equal(P.intToIpv4(P.ipv4ToInt('203.0.113.254')), '203.0.113.254');
  assert.equal(P.ipv4ToInt('300.1.1.1'), null);
  assert.equal(P.ipv4ToInt('not an address'), null);
  assert.equal(P.isIpv4(undefined), false);
});

test('private and local-only ranges', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(P.isPrivateV4(ip), true, ip);
  for (const ip of ['172.15.0.1', '172.32.0.1', '100.64.0.1', '198.51.100.1', '1.1.1.1']) assert.equal(P.isPrivateV4(ip), false, ip);
  assert.equal(P.isLocalOnly('127.0.0.1'), true);
  assert.equal(P.isLocalOnly('169.254.10.20'), true);
  assert.equal(P.isLocalOnly('192.168.1.1'), false);
});

test('the default route from /proc/net/route: up, through a gateway, lowest metric', () => {
  const text = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'wlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    'eth1\t00000000\t0102000A\t0002\t0\t0\t10\t00000000\t0\t0\t0',
    'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  ].join('\n');
  assert.deepEqual(P.parseProcRoute(text), { iface: 'eth0', gateway: '192.168.1.1' });
  assert.equal(P.parseProcRoute(''), null);
  assert.equal(P.parseProcRoute(null), null);
});

test('the Wi-Fi level from /proc/net/wireless, in dBm', () => {
  const head = 'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n'
    + ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n';
  const row = (level) => `${head} wlan0: 0000   54.  ${level}.  -256        0      0      0      0      0        0\n`;
  assert.equal(P.parseProcWireless(row(-56), 'wlan0'), -56);
  assert.equal(P.parseProcWireless(row(200), 'wlan0'), -56);   // an old driver's unsigned byte
  assert.equal(P.parseProcWireless(row(0), 'wlan0'), null);
  assert.equal(P.parseProcWireless(row(-56), 'wlan1'), null);
});

test('the signal Windows shows: -100 dBm is 0, -50 dBm and up is 100', () => {
  assert.equal(P.dbmToSignal(-100), 0);
  assert.equal(P.dbmToSignal(-75), 50);
  assert.equal(P.dbmToSignal(-60), 80);
  assert.equal(P.dbmToSignal(-30), 100);
  assert.equal(P.dbmToSignal(-120), 0);
  assert.equal(P.dbmToSignal(NaN), null);
});

test('ping lines: answers, losses, duplicates and errors', () => {
  assert.deepEqual(P.parsePingLine('64 bytes from 192.0.2.1: icmp_seq=3 ttl=57 time=12.3 ms'), { seq: 3, ms: 12.3 });
  assert.deepEqual(P.parsePingLine('no answer yet for icmp_seq=4'), { seq: 4, lost: true });
  assert.deepEqual(P.parsePingLine('Request timeout for icmp_seq 4'), { seq: 4, lost: true });
  assert.deepEqual(P.parsePingLine('64 bytes from 192.0.2.1: icmp_seq=5 ttl=57 time=11.802 ms'), { seq: 5, ms: 11.802 });
  assert.equal(P.parsePingLine('64 bytes from 192.0.2.1: icmp_seq=6 ttl=57 time=12.0 ms (DUP!)'), null);
  assert.deepEqual(P.parsePingLine('From 192.168.1.10 icmp_seq=7 Destination Host Unreachable'), { seq: 7, lost: true });
  assert.deepEqual(P.parsePingLine('From 198.51.100.1 icmp_seq=8 Time to live exceeded'), { seq: 8, lost: true });
  assert.equal(P.parsePingLine('PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.'), null);
  assert.equal(P.parsePingLine(''), null);
});

const HOPS = [
  { ttl: 1, ip: '192.168.1.1', ms: 0.401 },
  { ttl: 2, ip: '172.16.0.1', ms: 3.155 },
  { ttl: 3, ip: null, ms: null },
  { ttl: 4, ip: '198.51.100.1', ms: 6.02 },
];

test('tracepath: hops in order, the faster of a repeated hop, silent hops kept', () => {
  const out = [
    ' 1?: [LOCALHOST]                      pmtu 1500',
    ' 1:  192.168.1.1                                           0.512ms',
    ' 1:  192.168.1.1                                           0.401ms',
    ' 2:  172.16.0.1                                            3.155ms asymm  3',
    ' 3:  no reply',
    ' 4:  198.51.100.1                                          6.020ms',
    '     Too many hops: pmtu 1500',
    '     Resume: pmtu 1500',
  ].join('\n');
  assert.deepEqual(P.parseTracepath(out), HOPS);
  assert.deepEqual(P.parseTracepath(null), []);
});

test('BSD traceroute -n -q 1', () => {
  const out = [
    'traceroute to 1.1.1.1 (1.1.1.1), 5 hops max, 52 byte packets',
    ' 1  192.168.1.1  0.401 ms',
    ' 2  172.16.0.1  3.155 ms',
    ' 3  *',
    ' 4  198.51.100.1  6.020 ms',
  ].join('\n');
  assert.deepEqual(P.parseTraceroute(out), HOPS);
});

test('macOS route -n get default', () => {
  const out = '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n';
  assert.deepEqual(P.parseRouteGet(out), { iface: 'en0', gateway: '192.168.1.1' });
  assert.deepEqual(P.parseRouteGet('  interface: utun3\n'), { iface: 'utun3', gateway: null });
  assert.equal(P.parseRouteGet('route: writing to routing socket: not in table'), null);
});

test('macOS Wi-Fi devices from networksetup', () => {
  const out = 'Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n\nVLAN Configurations\n===================\n';
  assert.deepEqual([...P.parseWifiPorts(out)], ['en1']);
  assert.equal(P.parseWifiPorts(null).size, 0);
});

test('link kinds: Windows interface types and tunnel device names', () => {
  assert.equal(P.linkFromIfType(71), 'wifi');
  assert.equal(P.linkFromIfType(6), 'wired');
  assert.equal(P.linkFromIfType(243), 'mobile');
  for (const t of [53, 131, 23]) assert.equal(P.linkFromIfType(t), 'vpn');
  for (const name of ['utun3', 'wg0', 'tun0', 'tailscale0', 'ppp0']) assert.equal(P.POSIX_TUNNEL.test(name), true, name);
  for (const name of ['en0', 'eth0', 'wlan0', 'enp3s0']) assert.equal(P.POSIX_TUNNEL.test(name), false, name);
});
