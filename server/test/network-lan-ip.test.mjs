// The PC's LAN address on the System tile's Network card: the PC's IP without opening a
// terminal. Off by default, sent only by GET /network while the user has it
// on, and never handed to a Widget SDK widget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import { appStrings } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const { lanAddress } = require('../system/lan-address.js');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });
const v6 = (address) => ({ address, family: 'IPv6', internal: false });

// ── picking the address ────────────────────────────────────────────────────
test('the home network address wins over virtual adapters, VPNs and loopback', () => {
  const ifaces = {
    'vEthernet (WSL)': [v4('172.20.16.1')],
    'VMware Network Adapter VMnet8': [v4('192.168.40.1')],
    Tailscale: [v4('100.101.102.103')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    Ethernet: [v6('fe80::1'), v4('192.168.1.20')],
  };
  assert.equal(lanAddress(null, ifaces), '192.168.1.20');
});

test('macOS and Linux names are read the same way', () => {
  assert.equal(lanAddress(null, { lo0: [v4('127.0.0.1', true)], utun3: [v4('10.8.0.2')], en0: [v4('10.0.0.15')] }), '10.0.0.15');
  // Mac virtual links (Parallels, Internet Sharing, VM switches) never stand in for the Wi-Fi address.
  assert.equal(lanAddress(null, { vmenet0: [v4('10.211.55.2')], ap1: [v4('192.168.2.1')], vnic0: [v4('10.37.129.2')], en0: [v4('192.168.1.40')] }), '192.168.1.40');
  assert.equal(lanAddress(null, { vmenet0: [v4('10.211.55.2')], ap1: [v4('192.168.2.1')] }), null);
  assert.equal(lanAddress(null, { lo: [v4('127.0.0.1', true)], docker0: [v4('172.17.0.1')], 'br-1a2b': [v4('172.18.0.1')], wlan0: [v4('192.168.0.33')] }), '192.168.0.33');
});

test("the collector's physical adapters come first, and a name it does not know falls back", () => {
  const ifaces = { 'Ethernet 2': [v4('192.168.56.1')], 'Wi-Fi': [v4('192.168.1.40')] };
  const network = { interfaces: [{ name: 'Wi-Fi', kind: 'physical', up: true }, { name: 'Ethernet 2', kind: 'virtual', up: true }] };
  assert.equal(lanAddress(network, ifaces), '192.168.1.40', 'a host-only adapter the collector called virtual is passed over');
  assert.equal(lanAddress({ interfaces: [{ name: 'Other', kind: 'physical', up: true }] }, { en0: [v4('192.168.1.9')] }), '192.168.1.9');
  assert.equal(lanAddress({ interfaces: [{ name: 'Wi-Fi', kind: 'physical', up: false }] }, ifaces), '192.168.56.1', 'a disconnected adapter is not the one in use');
});

test('no address: offline, only link-local, or only virtual adapters', () => {
  assert.equal(lanAddress(null, {}), null);
  assert.equal(lanAddress(null, { Ethernet: [v4('169.254.10.2')] }), null);
  assert.equal(lanAddress(null, { 'vEthernet (Default Switch)': [v4('172.30.0.1')], lo: [v4('127.0.0.1', true)] }), null);
  assert.equal(lanAddress(null, { Ethernet: [v6('2001:db8::5')] }), null, 'IPv4 only');
});

// ── only GET /network, only when asked ─────────────────────────────────────
test('GET /network adds lanIp only while the setting is on, and leaves the shared reading alone', async () => {
  const { branches } = require('../system/routes-info.js');
  const { hub } = require('../settings/current.js');
  const shared = { ping: 12, downloadBps: 1000, interfaces: [] };
  const call = async () => {
    let out;
    await branches['GET /network']({}, {}, { json: (v) => { out = v; }, err500: (m) => { throw new Error(m); } }, { getNetworkInfo: async () => shared });
    return out;
  };
  const before = hub.settings;
  try {
    hub.settings = { networkShowIp: false };
    assert.equal('lanIp' in await call(), false);
    hub.settings = {};
    assert.equal('lanIp' in await call(), false, 'a missing setting is off');
    hub.settings = { networkShowIp: true };
    const on = await call();
    assert.ok('lanIp' in on);
    assert.ok(on.lanIp === null || typeof on.lanIp === 'string');
    assert.equal(on.ping, 12);
    assert.equal('lanIp' in shared, false, 'the cached reading Bit and perf share never gets it');
  } finally {
    hub.settings = before;
  }
});

test('the Widget SDK network stream never carries the address', () => {
  const src = read('../js/custom-widget/custom-widget.js');
  const at = src.indexOf('network: Object.freeze({ ttl:');
  const loader = src.slice(at, src.indexOf('} }),', at));
  assert.ok(at > 0);
  assert.doesNotMatch(loader, /lanIp|\.\.\.d\b/, 'the stream copies named fields only');
  assert.doesNotMatch(read('../system/network-info.js'), /lanIp|lanAddress/);
});

// ── the setting ────────────────────────────────────────────────────────────
test('the setting is off by default and kept on both sides and from a widget on the screen', () => {
  const { normalizeHubApp } = require('../settings/normalize-app.js');
  assert.equal(normalizeHubApp({ networkShowIp: true }).networkShowIp, true);
  assert.equal(normalizeHubApp({ networkShowIp: 'yes' }).networkShowIp, false);
  assert.equal(normalizeHubApp({}).networkShowIp, false);
  assert.equal(require('../settings/defaults-app.js').HUB_DEFAULTS_APP.networkShowIp, false);
  assert.match(read('../js/settings/normalize-settings.js'), /networkShowIp: value\.networkShowIp === true/);
  assert.equal(require('../grid/tile-settings.js').FIELDS.networkShowIp, 'bool');
});

test('Bit can switch it', () => {
  const SettingsAi = require('../ai/settings-ai.js');
  assert.deepEqual(SettingsAi.apply({}, SettingsAi.plan({ setting: 'network_ip', value: 'on' })).patch, { networkShowIp: true });
});

// ── the card ───────────────────────────────────────────────────────────────
function el(cls) {
  const kids = [];
  return {
    className: cls, hidden: false, textContent: '', title: '', kids,
    after(n) { kids.push(n); this.parent.kids.push(n); },
    appendChild(n) { kids.push(n); },
  };
}

function card({ on, lanIp }) {
  const bandwidth = { kids: [], querySelector(sel) {
    if (sel === ':scope > .stat-sub') return caption;
    if (sel === ':scope > .net-lan-ip') return this.kids.find((k) => k.className === 'net-lan-ip') || null;
    return null;
  }, appendChild(n) { this.kids.push(n); } };
  const caption = el('stat-sub');
  caption.parent = bandwidth;
  const root = { querySelector: (sel) => (sel === '[data-system-card="bandwidth"]' ? bandwidth : null) };
  const ctx = {
    hubSettings: { networkShowIp: on },
    lastNetworkData: null,
    t: (k) => ({ net_lan_ip: 'IP {ip}' })[k] || k,
    sf: () => null, setFill() {}, formatBandwidth: () => ({ value: '1', unit: 'Mbps' }),
    document: { createElement: () => el('') },
  };
  ctx.window = { DashboardGrid: { forEachInstance: (_id, fn) => fn(root) } };
  vm.createContext(ctx);
  vm.runInContext(read('../js/system/network.js'), ctx);
  const paint = (data) => vm.runInContext('applyNetwork', ctx)(data);
  paint({ lanIp });
  const line = () => bandwidth.querySelector(':scope > .net-lan-ip');
  return { ctx, caption, line, paint };
}

test('on, the card shows the address in place of its caption', () => {
  const c = card({ on: true, lanIp: '192.168.1.20' });
  assert.equal(c.line().textContent, 'IP 192.168.1.20');
  assert.equal(c.line().title, 'IP 192.168.1.20', 'the whole address on hover when an ellipsis cuts it');
  assert.equal(c.caption.hidden, true);
});

test('turned off, the line goes at once and the caption comes back', () => {
  const c = card({ on: true, lanIp: '192.168.1.20' });
  vm.runInContext('hubSettings = { networkShowIp: false }', c.ctx);
  c.paint({ lanIp: '192.168.1.20' });
  assert.equal(c.line().hidden, true);
  assert.equal(c.line().textContent, '');
  assert.equal(c.caption.hidden, false);
});

test('off from the start, nothing is added; on with no address, a dash', () => {
  assert.equal(card({ on: false }).line(), null);
  assert.equal(card({ on: true, lanIp: null }).line().textContent, 'IP --');
});

test('the line stays one line on a narrow card', () => {
  const css = read('../components/SystemPanel/SystemPanelSparkline.css');
  const rule = css.slice(css.indexOf('.net-lan-ip {'));
  const block = rule.slice(0, rule.indexOf('}'));
  for (const want of [/white-space: nowrap/, /overflow: hidden/, /text-overflow: ellipsis/, /min-width: 0/]) assert.match(block, want);
});

test('a switch on the Network card in both editors', () => {
  const dash = read('../js/dashboard-layout/layout-store-and-dock.js');
  assert.match(dash, /itemId === 'bandwidth'/);
  assert.match(dash, /saveTileSetting\(\{ networkShowIp: !on \}\)/);
  const layer = read('../js/layers/layer-edit-card.js');
  assert.match(layer, /saveTileSetting\(\{ networkShowIp: !on \}\)/);
});

test('the words are in every language', () => {
  const strings = appStrings();
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    for (const key of ['net_lan_ip', 'net_lan_ip_card', 'net_lan_ip_show', 'net_lan_ip_hide']) assert.ok(strings[lang][key], lang + ' ' + key);
    assert.match(strings[lang].net_lan_ip, /\{ip\}/, lang);
  }
});
