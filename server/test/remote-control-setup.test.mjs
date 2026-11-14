import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'remote-control.js'), 'utf8');

// Settings → Remote control had a dead end: the page swapped to the control
// panel the moment Sunshine and Tailscale were installed, which is only the
// first of four steps. Signing in to Tailscale, configuring Sunshine and pairing
// Moonlight lived in the steps that had just gone, so a user could install both
// tools and then have no way to finish. What is pinned here:
//
//  1. The steps stay on screen once both tools are in, until they are closed.
//  2. A page opened later, with the setup unfinished, can reach the steps again.
//  3. That way in exists in Settings only: the dashboard tile has no setup.
//  4. Enable, Disable and Remove all devices wait for the tools to be there.

const NOTHING = {
  ready: false,
  installed: { sunshine: false, tailscale: false },
  tailscale: { installed: false, connected: false, ip: '' },
  sunshineResponding: false,
  connectedClients: [],
  blocked: false,
  onDemand: false,
};
const TOOLS = {
  ...NOTHING,
  installed: { sunshine: true, tailscale: true },
  tailscale: { installed: true, connected: false, ip: '' },
};

function load(status, { inSettings = true } = {}) {
  const dom = makeDom();
  const overlay = dom.mkEl('div');
  overlay.id = inSettings ? 'settings-overlay' : 'dashboard';
  const host = dom.mkEl('div');
  host.setAttribute('data-remotef', 'mount');
  overlay.appendChild(host);
  dom.document.body.appendChild(overlay);

  const state = { status };
  const window = {};
  const sandbox = {
    window,
    document: dom.document,
    t: (key) => key,
    fetch: async (path) => ({
      json: async () => (path === '/remote/status' ? state.status : []),
    }),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    console,
  };
  vm.runInNewContext(SRC, sandbox);

  const keyed = (key) => dom.descendants(host).find((n) => n.getAttribute('data-i18n') === key);
  const render = async () => { await window.RemoteControl.init(host); await settle(); };
  return { state, keyed, render };
}

test('after the consent the steps show, and the controls wait for the tools', async () => {
  const page = load(NOTHING);
  await page.render();
  assert.ok(page.keyed('remote.consent_btn'), 'a new user starts from what this is');
  assert.equal(page.keyed('remote.step1_title'), undefined);

  page.keyed('remote.consent_btn').click();
  await settle();
  assert.ok(page.keyed('remote.step1_title'));
  assert.equal(page.keyed('remote.enable_btn'), undefined, 'nothing to enable yet');
  assert.equal(page.keyed('remote.setup_close'), undefined, 'nothing to go back to yet');
});

test('the steps stay on screen when both tools are installed', async () => {
  const page = load(NOTHING);
  await page.render();
  page.keyed('remote.consent_btn').click();
  await settle();

  page.state.status = TOOLS;
  await page.render();

  assert.ok(page.keyed('remote.tailscale_login_btn'), 'the sign-in step must be reachable');
  assert.ok(page.keyed('remote.enable_btn'));
  assert.equal(page.keyed('remote.panel_status'), undefined);
});

test('a page opened later can reach the steps, and they can be closed again', async () => {
  const page = load(TOOLS);
  await page.render();
  assert.equal(page.keyed('remote.tailscale_login_btn'), undefined, 'the panel comes first');

  const open = page.keyed('remote.setup_open');
  assert.ok(open, 'the only way to sign in or pair');
  assert.match(open.className, /primary/, 'an unfinished setup is the next thing to do');

  open.click();
  await settle();
  assert.ok(page.keyed('remote.tailscale_login_btn'));

  page.keyed('remote.setup_close').click();
  await settle();
  assert.equal(page.keyed('remote.tailscale_login_btn'), undefined);
  assert.ok(page.keyed('remote.setup_open'));
});

test('a finished setup keeps the way in, as one key among the others', async () => {
  const page = load({
    ...TOOLS,
    ready: true,
    sunshineResponding: true,
    tailscale: { installed: true, connected: true, ip: '100.64.0.7' },
  });
  await page.render();
  assert.doesNotMatch(page.keyed('remote.setup_open').className, /primary/);
});

test('the dashboard tile has no setup to open', async () => {
  const page = load(TOOLS, { inSettings: false });
  await page.render();
  assert.equal(page.keyed('remote.setup_open'), undefined);
  assert.ok(page.keyed('remote.kill_btn'));
});
