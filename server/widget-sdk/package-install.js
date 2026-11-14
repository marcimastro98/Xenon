'use strict';
// Puts a widget package in place: the staged swap an update uses, where a package came from and
// whether it may be shared on, and what an overwrite keeps.

const fs = require('node:fs');
const path = require('node:path');
const { WIDGET_ID_RE } = require('./package-names.js');

// ── Staged install (the automatic update path) ─────────────────────────────
// A plain install writes files OVER the package folder one at a time: a crash or
// a full disk half way leaves the old manifest with the new scripts, and a file
// the new version dropped stays behind. That is tolerable when the user pressed
// the button and is watching; it is not for an update nobody asked for at that
// moment. So this builds the new package in `stagingRoot`, swaps the two folders
// with renames, asks `verify()` whether the scan now sees the package, and puts
// the old folder back if anything in that sequence failed. The package is
// therefore either the old version, whole, or the new one, whole.
//
// `stagingRoot` must be on the same volume as `widgetsDir` (a rename is the only
// atomic step here) and must NOT be inside it: the folder scan would list a
// half-built package as a broken one.
async function renameWithRetry(from, to) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { await fs.promises.rename(from, to); return; }
    catch (e) {
      last = e;
      // Windows refuses to rename a folder something has a handle on (an
      // antivirus scan, an indexer). It is almost always gone within a second.
      if (!e || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}

async function installPackageStaged(widgetsDir, stagingRoot, validated, verify) {
  if (!validated || !validated.ok || !WIDGET_ID_RE.test(String(validated.id || ''))) return { ok: false, error: 'bad_payload' };
  const id = validated.id;
  const dest = path.join(widgetsDir, id);
  const stage = path.join(stagingRoot, id);
  const old = path.join(stagingRoot, id + '.previous');
  if (!dest.startsWith(widgetsDir + path.sep) || !stage.startsWith(stagingRoot + path.sep)) return { ok: false, error: 'bad_path' };
  const rm = (p) => fs.promises.rm(p, { recursive: true, force: true });
  let swapped = false;
  let hadOld = false;
  try {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    await rm(stage); await rm(old);   // leftovers of a run that died half way
    await fs.promises.mkdir(stage, { recursive: true });
    for (const f of validated.files) {
      const abs = path.join(stage, ...f.relPath.split('/'));
      if (abs !== stage && !abs.startsWith(stage + path.sep)) throw new Error('path_escape');
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, f.bytes);
    }
    hadOld = await fs.promises.access(dest).then(() => true, () => false);
    if (hadOld) await renameWithRetry(dest, old);
    try { await renameWithRetry(stage, dest); swapped = true; }
    catch (e) { if (hadOld) await renameWithRetry(old, dest); throw e; }
    if (typeof verify === 'function' && !(await verify())) throw new Error('verify_failed');
    await rm(old);
    return { ok: true };
  } catch (e) {
    // Put the old version back. A failure of THIS is the one case where the
    // package could be missing, so it is reported rather than swallowed.
    try {
      if (swapped) await rm(dest);
      if (hadOld && !(await fs.promises.access(dest).then(() => true, () => false))) await renameWithRetry(old, dest);
      await rm(stage);
    } catch (e2) { return { ok: false, error: 'rollback_failed', detail: String(e2 && e2.message || e2).slice(0, 120) }; }
    return { ok: false, error: e && e.message === 'verify_failed' ? 'verify_failed' : 'install_failed' };
  }
}

// ── Package origin (redistribution policy, not a security boundary) ─────────
// Where an installed package came from decides whether the user may RE-export
// it: only their own creations are shareable. Origins:
//   'import'  — arrived via a share code / bundle / community gallery
//   'creator' — built by the user (no-code Widget Creator or the AI tool)
//   'builtin' — the bundled example package
//   'local'   — a folder the developer built AND explicitly claimed as their own
//   'unknown' — no record: could be a dropped dev folder OR an install that
//               predates this tracking. FAIL-CLOSED: treated as NOT exportable
//               (we won't risk redistributing someone else's work). A developer
//               claims their own folder → 'local' to make it exportable again.
// Records live in DATA_DIR/widget-origins.json (server.js owns the store);
// these pure rules are unit-tested in sdk-widgets.test.mjs.
const WIDGET_ORIGINS = Object.freeze(['import', 'creator', 'builtin', 'local']);

// Merge a new install's origin with an existing record. Ownership is sticky in
// BOTH directions, so the redistribution flag can't be laundered by a replayed
// install:
//   - Own work stays own work: once a package is 'creator'/'local', a later
//     import-path reinstall (the author updating their widget from the catalog)
//     never demotes it.
//   - An import stays an import: once a package arrived as 'import', a later
//     'creator' claim can NOT relabel it as the user's own work. This closed a
//     replayable /sdk/install trick — re-POSTing an imported payload with
//     `origin:'creator'` appended flipped any imported widget to "created by
//     you", making someone else's work re-exportable/publishable. A genuine own
//     build uses a fresh id (or the Creator's editId, already 'creator' below).
// This is redistribution policy, not a security boundary (a local user still
// owns widget-origins.json); the enforceable anti-attribution-theft control is
// the catalog-side pkgId→author binding at publish.
function mergeOrigin(prev, next) {
  const p = WIDGET_ORIGINS.includes(prev) ? prev : null;
  const n = WIDGET_ORIGINS.includes(next) ? next : 'import';
  if (p === 'creator' || p === 'local') return p;
  if (p === 'import') return 'import';
  return n;
}

// Only the user's own work may leave the machine as a share code. Fail-closed:
// anything we can't positively attribute to the user ('unknown', 'import',
// 'builtin', null) is NOT exportable — a dev folder becomes exportable only once
// explicitly claimed ('local').
function originExportable(origin) {
  return origin === 'creator' || origin === 'local';
}

// May an install write over a package id that is already installed?
//
// Grants are keyed by package id and nothing else. A share code carrying the id
// of a widget the user already approved used to replace its files silently and
// run with every permission the user had given the ORIGINAL — the camera feed,
// the Deck actions, the hosts — without a single question. So writing over an
// installed id is refused unless one of three things is true:
//   - it is the user's own build being edited (the Creator, Bit's create_widget):
//     origin 'creator' over a package the user owns;
//   - it is the Store updating the same catalog entry it installed (the Update
//     button, the Store's own install of a newer version): the caller works that
//     out from the origin record and the catalog, never from the payload alone;
//   - the user saw "this replaces …" and confirmed (`replace: true`). Then the
//     old grants go with the old code (`dropGrants`), and the new package asks
//     for its permissions like any new widget.
// Pure: every fact is computed by the caller.
function installOverwrite(o) {
  const x = o && typeof o === 'object' ? o : {};
  if (x.exists !== true) return { ok: true, dropGrants: false };
  if (x.origin === 'creator' && x.own === true) return { ok: true, dropGrants: false };
  if (x.origin !== 'creator' && x.catalogUpdate === true) return { ok: true, dropGrants: false };
  if (x.replace === true) return { ok: true, dropGrants: true };
  return { ok: false, error: 'id_exists' };
}

// Grants made before the approved `storageGroup` was recorded in them. The
// group decides WHOSE store a package reads (a shared namespace among siblings),
// so it is now part of what the user approved: a manifest that adds or changes
// it asks again. A grant that predates the field is taken as approval of the
// group the package has NOW, the one the user saw when they approved it, so
// nobody's working widget turns into a permission prompt on update. Every grant
// gets the field ('' when the package has no group, or is not installed), so
// this runs once in effect: a second pass finds nothing to fill.
// Returns { grants, changed } and never mutates its input.
function migrateGrantStorageGroups(grants, packages) {
  const src = grants && typeof grants === 'object' && !Array.isArray(grants) ? grants : {};
  const byId = new Map((Array.isArray(packages) ? packages : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  const out = {};
  let changed = false;
  for (const id of Object.keys(src)) {
    const g = src[id];
    if (!g || typeof g !== 'object' || typeof g.storageGroup === 'string') { out[id] = g; continue; }
    const pkg = byId.get(id);
    out[id] = { ...g, storageGroup: pkg && typeof pkg.storageGroup === 'string' ? pkg.storageGroup : '' };
    changed = true;
  }
  return { grants: changed ? out : src, changed };
}

module.exports = {
  renameWithRetry, installPackageStaged, WIDGET_ORIGINS, mergeOrigin, originExportable,
  installOverwrite, migrateGrantStorageGroups,
};
