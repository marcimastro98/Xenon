// A widget holding the `url` grant can ask the host to open ANY address — and
// the addresses that matter are the ones it never declared, because `hosts`
// governs fetch, not links. A news widget opens whatever its feed says, so the
// only thing standing between a hijacked feed and the user's browser is the host
// naming the destination out loud. These tests pin that gate: which opens are
// silent, which ask, and what a decline does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');

/** Load the gate with the confirmation dialog replaced by a recording stub. */
function loadGate() {
  const start = SRC.indexOf('const approvedExternalHosts');
  const end = SRC.indexOf('function openClipboardConfirm');
  assert.ok(start > 0 && end > start, 'external-open gate not found in custom-widget.js');

  const prompts = [];
  const context = vm.createContext({
    document: { querySelector: () => null, body: { appendChild() {} } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    el: () => ({ appendChild() {}, addEventListener() {}, append() {}, focus() {}, type: '' }),
    t: (_key, fallback) => fallback,
    packageById: () => ({ name: 'Test Widget' }),
    URL,
    Set,
    prompts,
  });
  // The gate calls cwForbiddenHost, which lives higher up in the file and is
  // outside the slice. Load the REAL one rather than a stub, so a change to the
  // predicate is exercised by these tests instead of being masked by a copy.
  const hostFnStart = SRC.indexOf('function cwForbiddenHost');
  const hostFnEnd = SRC.indexOf('function cwPrivateHost');
  assert.ok(hostFnStart > 0 && hostFnEnd > hostFnStart, 'cwForbiddenHost not found in custom-widget.js');
  vm.runInContext(SRC.slice(hostFnStart, hostFnEnd), context);
  vm.runInContext(SRC.slice(start, end), context);

  // Answer the prompt without a DOM: record what was asked, return the decision.
  let decision = true;
  context.openExternalConfirm = async ({ pkgId, url }) => {
    prompts.push({ pkgId, host: url.hostname });
    return decision;
  };
  return {
    prompts,
    setDecision(v) { decision = v; },
    approve: (entry, grant, url) => context.externalOpenApproved(entry, grant, url),
  };
}

const entry = { pkgId: 'dgm-news' };
const grantWith = (hosts) => ({ hosts });

test('a host the package declared opens without asking', async () => {
  const g = loadGate();
  assert.equal(await g.approve(entry, grantWith(['feeds.bbci.co.uk']), 'https://feeds.bbci.co.uk/sport/rss.xml'), true);
  assert.equal(g.prompts.length, 0);
});

test('declared-host matching ignores case and does not match by suffix', async () => {
  const g = loadGate();
  assert.equal(await g.approve(entry, grantWith(['Feeds.BBCI.co.uk']), 'https://feeds.bbci.co.uk/x'), true);
  assert.equal(g.prompts.length, 0);
  // evil-bbci.co.uk must not ride in on a declared bbci.co.uk.
  await g.approve(entry, grantWith(['bbci.co.uk']), 'https://evil-bbci.co.uk/x');
  assert.equal(g.prompts.length, 1);
  assert.equal(g.prompts[0].host, 'evil-bbci.co.uk');
});

test('an undeclared host asks, and names the host it is asking about', async () => {
  const g = loadGate();
  assert.equal(await g.approve(entry, grantWith([]), 'https://www.marca.com/futbol/x.html'), true);
  assert.deepEqual(g.prompts, [{ pkgId: 'dgm-news', host: 'www.marca.com' }]);
});

test('approval is remembered for that host, so a reader is not asked twice', async () => {
  const g = loadGate();
  await g.approve(entry, grantWith([]), 'https://www.marca.com/a');
  await g.approve(entry, grantWith([]), 'https://www.marca.com/b');
  assert.equal(g.prompts.length, 1);
});

// The whole point of remembering: a NEW destination still surfaces. That is the
// hijacked-feed case.
test('a different host asks again even after one was approved', async () => {
  const g = loadGate();
  await g.approve(entry, grantWith([]), 'https://www.marca.com/a');
  await g.approve(entry, grantWith([]), 'https://totally-elsewhere.example/a');
  assert.deepEqual(g.prompts.map((p) => p.host), ['www.marca.com', 'totally-elsewhere.example']);
});

test('a decline blocks the open and is not remembered as consent', async () => {
  const g = loadGate();
  g.setDecision(false);
  assert.equal(await g.approve(entry, grantWith([]), 'https://www.marca.com/a'), false);
  assert.equal(await g.approve(entry, grantWith([]), 'https://www.marca.com/a'), false);
  assert.equal(g.prompts.length, 2, 'a declined host must ask again, not stay silently blocked');
});

test('one package approving a host does not approve it for another', async () => {
  const g = loadGate();
  await g.approve({ pkgId: 'widget-a' }, grantWith([]), 'https://example.com/x');
  await g.approve({ pkgId: 'widget-b' }, grantWith([]), 'https://example.com/x');
  assert.deepEqual(g.prompts.map((p) => p.pkgId), ['widget-a', 'widget-b']);
});

test('non-web schemes are refused without ever prompting', async () => {
  const g = loadGate();
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'steam://rungameid/440', 'data:text/html,<script>x</script>']) {
    assert.equal(await g.approve(entry, grantWith([]), url), false, url + ' must be refused');
  }
  assert.equal(g.prompts.length, 0);
});

test('an unparseable url is refused without prompting', async () => {
  const g = loadGate();
  for (const url of ['', null, undefined, 'not a url', 'https://']) {
    assert.equal(await g.approve(entry, grantWith([]), url), false);
  }
  assert.equal(g.prompts.length, 0);
});

// Wiring: the gate is worthless if the dispatcher does not consult it.
test('onBridgeAction gates openUrl and reports a decline as declined', () => {
  const handler = SRC.slice(SRC.indexOf('async function onBridgeAction'), SRC.indexOf('// Proxied fetch'));
  assert.match(handler, /externalOpenApproved\(entry, grant, msg\.action\.url\)/);
  assert.match(handler, /error: 'declined'/);
  // The check has to happen before the action reaches the server runner.
  assert.ok(
    handler.indexOf('externalOpenApproved') < handler.indexOf("api('/actions/run'"),
    'the confirmation must gate the dispatch, not follow it',
  );
});

// The two host-side prompts must not share a backdrop class: closeClipConfirm()
// closes by querying '.cw-clip-backdrop', so a shared class would let one dialog
// tear down the other and resolve the wrong promise.
test('the external-open dialog does not share the clipboard backdrop class', () => {
  const block = SRC.slice(SRC.indexOf('function openExternalConfirm'), SRC.indexOf('function openClipboardConfirm'));
  const backdrop = block.match(/el\('div', '([^']*backdrop[^']*)'\)/);
  assert.ok(backdrop, 'external confirm backdrop element not found');
  assert.equal(backdrop[1], 'cw-ext-backdrop');
});

// openUrl hands the address to the SYSTEM browser, which loads it as a top-level
// navigation: the same shape browserOpen produces, and the shape the server's
// mutation gate had to start rejecting. A dialog reading "127.0.0.1" is not
// consent anyone can meaningfully give, so loopback is refused before the
// granted-hosts check and before the prompt.
test('loopback is refused outright, with no prompt and no way to grant it', async () => {
  const gate = loadGate();
  for (const url of [
    'http://127.0.0.1:3030/notes?save=1&data=',
    'http://127.0.0.1/toggle',
    'http://localhost:3030/api/settings',
    'http://[::1]:3030/volume/set?v=100',
    'http://0.0.0.0:3030/',
  ]) {
    assert.equal(await gate.approve(entry, grantWith([]), url), false, `${url} must be refused`);
  }
  assert.equal(gate.prompts.length, 0, 'a loopback address must never reach the dialog');
});

// The refusal must not be escapable by declaring the host in the manifest: the
// install-time grant check is what a hostile package would target.
test('a granted host cannot whitelist loopback', async () => {
  const gate = loadGate();
  assert.equal(await gate.approve(entry, grantWith(['127.0.0.1']), 'http://127.0.0.1:3030/notes?save='), false);
  assert.equal(await gate.approve(entry, grantWith(['localhost']), 'http://localhost:3030/toggle'), false);
  assert.equal(gate.prompts.length, 0);
});

// LAN stays open on purpose: opening a NAS or a printer page is a real use, and
// unlike loopback the destination is meaningful to the person approving it.
test('LAN addresses still go through the normal consent path', async () => {
  const gate = loadGate();
  assert.equal(await gate.approve(entry, grantWith([]), 'http://192.168.1.50:32400/web'), true);
  assert.equal(gate.prompts.length, 1, 'a LAN address is asked about, not silently refused');
  assert.equal(gate.prompts[0].host, '192.168.1.50');
});
