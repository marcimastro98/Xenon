// The dashboard that came back as the factory default after an update.
//
// Reported on Discord (macOS). What was lost: the layout, and with it the Deck
// tile. What survived: the theme, the connected Google Calendar, every installed
// widget, and settings.json itself. One field of that file reverted to its
// default while all of its siblings stayed exactly as they were — and there is
// precisely one mechanism in this codebase with that signature.
//
//   const layoutVersion = Number(source.dashboardLayoutVersion) || 0;
//   const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
//
// It is written as a one-time upgrade step, but it lives in normalizeHubSettings,
// which runs on EVERY save. So it reads the version off the incoming body: any
// writer that does not model the field — a partial save, a surface built later,
// a restored blob — is read as "version 0" and has the whole dashboard replaced,
// after which the file is re-stamped with the current version and there is
// nothing left on disk to find.
//
// Two changes, pinned here. A save that omits the field inherits the stored one,
// exactly like remoteAccess and fileTransfer already do. And when the migration
// genuinely does fire, the layout it supersedes is copied out first instead of
// being overwritten by the next save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const POST = (() => {
  const start = SERVER.indexOf("reqPath === '/settings' && req.method === 'POST'");
  assert.ok(start > 0, 'the settings writer is still where this test looks');
  return SERVER.slice(start, SERVER.indexOf('} else if (reqPath', start + 200));
})();

test('a save that does not carry the layout version inherits the stored one', () => {
  assert.match(POST,
    /if \(prev && incoming\.dashboardLayoutVersion == null && prev\.dashboardLayoutVersion != null\) \{\s*\n\s*incoming\.dashboardLayoutVersion = prev\.dashboardLayoutVersion;/,
    'an absent version means "this writer does not model it", not version 0');
});

// `== null` and not a falsy test: version 0 is a real (ancient) value that must
// still migrate, and `|| prev` would swallow it.
test('a genuinely old version still migrates', () => {
  const guard = POST.slice(POST.indexOf('incoming.dashboardLayoutVersion == null'));
  assert.doesNotMatch(guard.slice(0, 200), /!incoming\.dashboardLayoutVersion/,
    'the guard tests for absence, never for falsiness');
});

// The migration is the one destructive step in the app that is neither confirmed
// nor reversible — it runs at boot, unasked, and the user finds out by looking.
test('a superseded layout is copied out before anything overwrites it', () => {
  const fn = SERVER.slice(SERVER.indexOf('function backupSupersededLayout()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(fs\.existsSync\(LAYOUT_BACKUP_FILE\)\) return null;/,
    'an existing backup is never overwritten by a later pass');
  assert.match(body, /fs\.readFileSync\(SETTINGS_FILE/,
    'read synchronously — the raw old version only exists until the first write');
  assert.match(body, /if \(from >= DASHBOARD_LAYOUT_VERSION\) return null;/,
    'nothing to keep when no migration is due');
  assert.match(body, /if \(!layout \|\| typeof layout !== 'object'\) return null;/,
    'and nothing to keep on a fresh install');
  assert.match(body, /catch \{ return null; \}/, 'a failing backup never blocks the boot');
});

// The from-version has to come off the raw file: the normalized settings are
// already stamped with the current one and would report "6 → 6".
test('the log names the version being left behind, not the one being adopted', () => {
  const fn = SERVER.slice(SERVER.indexOf('function backupSupersededLayout()'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /const from = Number\(raw && raw\.dashboardLayoutVersion\) \|\| 0;/,
    'read from the raw file');
  const boot = SERVER.slice(SERVER.indexOf('const backup = backupSupersededLayout();'));
  const said = boot.slice(0, boot.indexOf('\n      }'));
  assert.match(said, /backup\.from/, 'and reported from there');
  assert.match(said, /The layout you had is kept at/, 'the log says where it is');
});

// A backup that restores the tiles and loses every picture on them is worth less
// than it looks: the asset sweep runs on the very next save.
test('the kept layout protects its own tile images from the sweep', () => {
  const fn = SERVER.slice(SERVER.indexOf('function cleanupUnreferencedTileAssets(layout, presets)'));
  assert.match(fn.slice(0, 400), /for \(const f of layoutBackupAssetRefs\(\)\) referenced\.add\(f\);/,
    'the sweep counts the backup as a reference');
  const refs = SERVER.slice(SERVER.indexOf('function layoutBackupAssetRefs()'));
  const body = refs.slice(0, refs.indexOf('\n}'));
  // Memoizing a failed read would cache "none" for a sweep that ran before boot
  // wrote the file, and the protection would never come back.
  assert.ok(body.indexOf('_layoutBackupRefs = set;') > body.indexOf('const set = new Set();'),
    'only a successful read is memoized');
  assert.match(body, /catch \{ return new Set\(\); \}/, 'a missing backup protects nothing, quietly');
});
