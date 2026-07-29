import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The screen choice is stored TWICE on purpose — in the native shell's own
// display.json, which it must be able to read at launch before the backend is
// necessarily up, and in hub settings, which is what Settings renders and the
// only copy a paired phone can write. Two stores means two normalizers, and a
// drift between them is not a cosmetic bug: `POST /settings` rebuilds the whole
// blob from the incoming payload, so a key one half emits and the other drops is
// reset to its default on every save, from every surface, silently.
//
// That is the exact mechanism that switched paired-device access off by itself
// (see settings-server-owned-keys.test.mjs). This test pins the two halves to
// the same shape and the same rules.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, '..', 'js', 'settings.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');

/** Lift a normalizer out of its file and evaluate it in isolation. */
function lift(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} not found`);
  // Functions here are flat: the first line at column 0 starting with `}` ends it.
  const end = source.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} has no end`);
  const body = source.slice(at, end + 2);
  // The REAL declaration, lifted from the same file — not a copy written here.
  // A copy would keep passing while the two halves drifted apart, which is the
  // one failure this file exists to catch.
  const kinds = /^const SURFACE_KINDS = \[[^\]]*\];$/m.exec(source);
  assert.ok(kinds, 'SURFACE_KINDS not found');
  // eslint-disable-next-line no-new-func
  return new Function(`${kinds[0]}\n${body}\nreturn ${name};`)();
}

const client = lift(CLIENT, 'normalizeSurface');
const server = lift(SERVER, 'normalizeSurfaceChoice');
const BOTH = [['client', client], ['server', server]];

test('both halves produce the identical shape, for identical input', () => {
  const inputs = [
    undefined,
    null,
    {},
    'not an object',
    { kind: 'phone', asked: true },
    { kind: 'screen', asked: true, monitor: '\\\\.\\DISPLAY2', label: 'Display 2 — 2560×720' },
    { kind: 'nonsense', asked: 'yes', monitor: 42, label: {} },
  ];
  for (const input of inputs) {
    assert.deepEqual(
      client(input),
      server(input),
      `the two normalizers disagree on ${JSON.stringify(input)}`
    );
  }
});

test('the default is auto and unasked — never a screen nobody chose', () => {
  for (const [who, fn] of BOTH) {
    assert.deepEqual(fn(undefined), { kind: 'auto', asked: false, monitor: '', label: '' }, who);
    assert.deepEqual(fn({}), { kind: 'auto', asked: false, monitor: '', label: '' }, who);
  }
});

test('an unknown kind degrades to auto rather than being carried through', () => {
  // A value written by a newer build (or a corrupted file) must not become a
  // mode the shell has no branch for — that would be a window nobody places.
  for (const [who, fn] of BOTH) {
    for (const kind of ['tv', 'PHONE', '', 0, null, ['phone']]) {
      assert.equal(fn({ kind }).kind, 'auto', `${who} accepted ${JSON.stringify(kind)}`);
    }
  }
});

test('the four real kinds survive', () => {
  for (const [who, fn] of BOTH) {
    for (const kind of ['auto', 'screen', 'phone', 'both']) {
      assert.equal(fn({ kind }).kind, kind, who);
    }
  }
});

test("'both' is a settings answer, not a shell placement", () => {
  // 'both' means "the phone AND this PC", and the PC half of that is exactly
  // what 'auto' already does — so the shell is told 'auto' and has no third
  // branch to grow. A `xenon-display:both` verb would be a scheme the shell does
  // not know, which on Windows raises the OS "how do you want to open this?"
  // dialog on the kiosk.
  const LIB = fs.readFileSync(
    path.join(HERE, '..', '..', 'apps', 'native', 'src-tauri', 'src', 'lib.rs'),
    'utf8'
  );
  assert.ok(!/"both" =>/.test(LIB), 'lib.rs grew a "both" display signal');
  assert.ok(!/xenon-display:both/.test(
    fs.readFileSync(path.join(HERE, '..', 'js', 'native-bridge.js'), 'utf8')
  ), 'native-bridge.js sends a "both" display signal');
  // And the client must place it, not leave the window wherever it was: the way
  // OUT of "nothing on this PC" is choosing 'both', so it has to tell the shell.
  const apply = /function applySurfaceKind\([\s\S]*?\n}/.exec(CLIENT);
  assert.ok(apply, 'applySurfaceKind not found');
  const branch = /kind === 'both'\)\s*\{([\s\S]*?)\}\s*else/.exec(apply[0]);
  assert.ok(branch, "applySurfaceKind has no 'both' branch");
  assert.match(branch[1], /chooseAutoScreen/, "the 'both' branch does not place the window");
});

test('`asked` is true only when it is literally true', () => {
  // It gates a once-per-install dialog. Anything truthy-but-not-true would let a
  // corrupted value silently suppress the question forever.
  for (const [who, fn] of BOTH) {
    assert.equal(fn({ asked: true }).asked, true, who);
    for (const v of [1, 'true', 'yes', {}, [], undefined]) {
      assert.equal(fn({ asked: v }).asked, false, `${who} accepted ${JSON.stringify(v)}`);
    }
  }
});

test('the monitor name and label are bounded, and non-strings become empty', () => {
  const long = 'x'.repeat(1000);
  for (const [who, fn] of BOTH) {
    const out = fn({ monitor: long, label: long });
    assert.equal(out.monitor.length, 256, who);
    assert.equal(out.label.length, 120, who);
    for (const v of [42, null, {}, [], true]) {
      assert.equal(fn({ monitor: v }).monitor, '', `${who} monitor ${JSON.stringify(v)}`);
      assert.equal(fn({ label: v }).label, '', `${who} label ${JSON.stringify(v)}`);
    }
  }
});

test('a Windows display name round-trips unmangled', () => {
  // The name is the key the shell resolves against the live monitor list, and it
  // is full of backslashes. Mangling it here would make the choice unresolvable
  // and the window would hide instead of moving.
  const name = '\\\\.\\DISPLAY2';
  for (const [who, fn] of BOTH) {
    assert.equal(fn({ kind: 'screen', monitor: name }).monitor, name, who);
  }
});

test('the shell prefs and the settings key agree on the three mode names', () => {
  // The Rust side matches on these exact lowercase strings (prefs.rs
  // `placement_or_auto`), and the scheme verbs are named after them. A rename on
  // one side alone would silently mean "auto" forever.
  const RUST = fs.readFileSync(
    path.join(HERE, '..', '..', 'apps', 'native', 'src-tauri', 'src', 'prefs.rs'),
    'utf8'
  );
  for (const kind of ['screen', 'phone']) {
    assert.match(RUST, new RegExp(`Some\\("${kind}"\\)`), `prefs.rs does not accept "${kind}"`);
  }
  const LIB = fs.readFileSync(
    path.join(HERE, '..', '..', 'apps', 'native', 'src-tauri', 'src', 'lib.rs'),
    'utf8'
  );
  for (const verb of ['auto', 'phone', 'screen', 'fullscreen']) {
    assert.match(LIB, new RegExp(`"${verb}" =>`), `lib.rs has no xenon-display:${verb} verb`);
  }
});

test('every writer of the placement reconciles the login entry', () => {
  // The choice is only honoured if the app's autostart follows it. Picking a
  // screen from the tray is the way OUT of phone mode, and when it did not
  // reconcile, the window came back immediately and was gone again at the next
  // login — a setting applied by half, which is the failure this whole feature
  // exists to remove. Any new writer must do the same.
  const MONITOR = fs.readFileSync(
    path.join(HERE, '..', '..', 'apps', 'native', 'src-tauri', 'src', 'monitor.rs'),
    'utf8'
  );
  const writers = [...MONITOR.matchAll(/p\.placement = /g)];
  assert.ok(writers.length >= 2, 'expected the two placement writers');
  for (const w of writers) {
    // The reconcile must land inside the same function: look ahead to the end of
    // the enclosing fn (the next line starting at column 0 with `}`).
    const rest = MONITOR.slice(w.index);
    const fnEnd = rest.indexOf('\n}');
    assert.match(
      rest.slice(0, fnEnd),
      /crate::sync_autostart\(app\)/,
      'a function that writes p.placement does not call sync_autostart'
    );
  }
});

test('the client sends the key, so the server can never reset it', () => {
  // The guarantee settings-server-owned-keys.test.mjs enforces generally, stated
  // once more here because THIS key is the one that decides whether a PC shows
  // anything at all at login.
  assert.match(CLIENT, /surfaceChoice: normalizeSurface\(surfaceChoiceFrom\(value\)\)/);
  assert.match(SERVER, /surfaceChoice: normalizeSurfaceChoice\(surfaceChoiceFrom\(source\)\)/);
  // And both defaults exist, so a settings file written before this feature
  // hydrates to "never asked" rather than to undefined.
  const DEFAULT = /surfaceChoice: Object\.freeze\(\{ kind: 'auto', asked: false, monitor: '', label: '' \}\)/;
  assert.match(CLIENT, DEFAULT, 'the client default is missing');
  assert.match(SERVER, DEFAULT, 'the server default is missing');
});

// Both files are checked in with CRLF, so every boundary match here works on a
// normalised copy rather than depending on which machine wrote them last.
const lf = (s) => s.replace(/\r\n/g, '\n');

/** The source of a top-level `function <name>(` up to its closing brace. */
function fnBody(src, name) {
  const start = lf(src).indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = lf(src).indexOf('\n}\n', start);
  return end < 0 ? lf(src).slice(start) : lf(src).slice(start, end + 3);
}

// The choice was originally stored under `surface`, which is ALSO the theme's
// main panel colour. Both halves assigned it in the SAME object literal, so the
// choice won and the colour became `{kind, asked, monitor, label}` on every
// save. Nothing threw where it happened; it threw later, in Settings, on
// `val.toUpperCase()`, and took down every panel mounted after that line —
// paired devices, file transfer, the Sunshine wizard, Streaming, Spotify, Smart
// Home, Cameras and the external-calendar section all silently stopped
// rendering. The count below is what makes that visible at the point of damage.
test('the screen choice does not collide with the theme colour of the same name', () => {
  for (const [name, src, arg, fn] of [
    ['client', CLIENT, 'value', 'normalizeSettings'],
    ['server', SERVER, 'source', 'normalizeHubSettings'],
  ]) {
    const body = fnBody(src, fn);
    assert.ok(body, `${name}: ${fn} not found`);
    // The colour still normalizes as a colour...
    assert.match(body, new RegExp(`surface: normalizeHex\\(${arg}\\.surface, null\\)`),
      `${name}: the theme's surface colour must still be normalized as a hex`);
    // ...and nothing else claims that key in the same rebuild.
    const claims = body.match(/^\s*surface:/gm) || [];
    assert.equal(claims.length, 1,
      `${name}: '${fn}' assigns 'surface:' ${claims.length} times. Two features writing one key `
      + 'in one object literal is silent — the later wins and the other is destroyed.');
  }
});

test('a settings blob written under the old key keeps its screen', () => {
  // The migration reads the old spelling exactly once, and only when it holds an
  // OBJECT: a real colour there is a string and must never become a screen.
  for (const [name, src] of [['client', CLIENT], ['server', SERVER]]) {
    const body = fnBody(src, 'surfaceChoiceFrom');
    assert.ok(body, `${name}: surfaceChoiceFrom is missing`);
    assert.match(body, /s\.surfaceChoice && typeof s\.surfaceChoice === 'object'/, `${name}: new key not preferred`);
    assert.match(body, /s\.surface && typeof s\.surface === 'object'/, `${name}: legacy object not accepted`);
  }
});
