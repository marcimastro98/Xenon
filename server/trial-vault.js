'use strict';

// Widgets and Ambient scenes unlocked with the 7-day pass trial never reach
// DATA_DIR/widgets in plaintext. The drop's public locked file is kept here
// (DATA_DIR/trial-vault/<entryId>.json, ciphertext only); its key is asked from
// the hub at every start, through the running trial, and the decrypted packages
// live in memory only. While the trial runs they are listed and served like any
// installed package, under the origin 'trial' (never exportable, never claimable,
// never auto-updated). When it ends, they stop being served at once and the
// files are deleted; when the trial converts, each drop is redeemed again with
// the supporter pass and installed for good.
//
// This raises the bar, it is not DRM: whatever a running widget renders reaches
// the browser while the trial runs. What it removes is the copy left behind.

const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const sdkWidgets = require('./sdk-widgets.js');

const DIR = 'trial-vault';
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const VERSION_RE = /^[0-9A-Za-z._+-]{1,32}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;
const MAX_RECORDS = 64;
const MAX_CT_CHARS = 48 * 1024 * 1024;
const GCM_TAG_BYTES = 16;
// A start that could not get the keys (offline, hub busy) tries again on the
// next request for a trial widget, but not more often than this.
const RETRY_GAP_MS = 30 * 1000;
// Answers about the DROP that asking again will not change: the record is dropped.
// (A refusal about the trial itself, expired or bad_code, is settled by the trial
// check that refusal triggers; 'limit' on conversion waits for a free device slot.)
const DEAD_ENTRY_ERRORS = new Set(['bad_entry', 'not_in_trial', 'wrong_code']);
// A validator for asset paths only: resolveAsset checks against a root, and the
// vault has none, so a fixed one stands in for it.
const VIRTUAL_ROOT = path.resolve('/xenon-trial-vault');

// AES-256-GCM, the WebCrypto layout: the 16-byte tag closes the ciphertext.
function decryptEnvelope(enc, cekB64) {
  try {
    const key = Buffer.from(String(cekB64 || ''), 'base64');
    const iv = Buffer.from(String(enc && enc.iv || ''), 'base64');
    const all = Buffer.from(String(enc && enc.ct || ''), 'base64');
    if (key.length !== 32 || iv.length < 12 || all.length <= GCM_TAG_BYTES) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(all.subarray(all.length - GCM_TAG_BYTES));
    return Buffer.concat([d.update(all.subarray(0, all.length - GCM_TAG_BYTES)), d.final()]).toString('utf8');
  } catch { return null; }
}

// The decrypted inner code: plain JSON or its base64url form.
function parseInner(inner) {
  if (typeof inner !== 'string' || !inner) return null;
  const s = inner.trim();
  try {
    const obj = JSON.parse(s.charAt(0) === '{' ? s : Buffer.from(s, 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object' ? obj : null;
  } catch { return null; }
}

// Where a preset carries widget packages: the data itself for a widget or scene,
// data.widgets[] for a bundle, a deck profile or a canvas scene.
function widgetSlots(preset) {
  const data = preset && preset.data;
  if (!data || typeof data !== 'object') return [];
  if (preset.kind === 'widget' || preset.kind === 'ambient') return data.payload ? [data] : [];
  return Array.isArray(data.widgets) ? data.widgets.filter((w) => w && typeof w === 'object' && w.payload) : [];
}

// Every valid package in a decrypted inner code, by id.
function packagesOf(inner) {
  const out = new Map();
  for (const slot of widgetSlots(parseInner(inner))) {
    const v = sdkWidgets.validateWidgetPayload(slot.payload);
    if (v.ok) out.set(v.id, v);
  }
  return out;
}

// The inner code the dashboard gets: the same preset, each package replaced by a
// marker the import flow hands back to /sdk/install to put it in place.
function stubInner(inner) {
  const preset = parseInner(inner);
  if (!preset) return null;
  for (const slot of widgetSlots(preset)) {
    const v = sdkWidgets.validateWidgetPayload(slot.payload);
    slot.payload = v.ok ? { trialVault: true, id: v.id } : null;
  }
  return Buffer.from(JSON.stringify(preset), 'utf8').toString('base64url');
}

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || !ENTRY_ID_RE.test(String(raw.entryId || ''))) return null;
  const enc = raw.enc || {};
  if (typeof enc.iv !== 'string' || !B64_RE.test(enc.iv) || enc.iv.length > 64) return null;
  if (typeof enc.ct !== 'string' || !B64_RE.test(enc.ct) || enc.ct.length > MAX_CT_CHARS) return null;
  const widgets = [];
  for (const w of Array.isArray(raw.widgets) ? raw.widgets.slice(0, 40) : []) {
    if (!w || !WIDGET_ID_RE.test(String(w.id || ''))) continue;
    // Read back from disk, so it goes through the package normaliser again.
    const m = sdkWidgets.normalizeManifest(w.manifest, w.id);
    if (m.ok) widgets.push({ id: w.id, raw: w.manifest, manifest: m.manifest, accepted: w.accepted === true });
  }
  return {
    entryId: raw.entryId,
    kv: Number.isInteger(raw.kv) && raw.kv >= 1 && raw.kv <= 1000 ? raw.kv : 1,
    enc: { iv: enc.iv, ct: enc.ct },
    catalogVersion: VERSION_RE.test(String(raw.catalogVersion || '')) ? raw.catalogVersion : '',
    at: Number.isFinite(raw.at) ? raw.at : 0,
    widgets,
  };
}

function createTrialVault({ dataDir, trialPass, redeem, installPayload, onChange = () => {}, now = Date.now }) {
  const dir = path.join(dataDir, DIR);
  const records = new Map();   // entryId -> record (ciphertext + manifests)
  const opened = new Map();    // entryId -> Map(id -> validated package), memory only
  let lastTry = 0;
  let lastPromote = 0;
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const fileOf = (entryId) => path.join(dir, entryId + '.json');
  const changed = () => { try { onChange(); } catch { /* listing refresh is best-effort */ } };

  async function init() {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const name of names.filter((n) => n.endsWith('.json')).slice(0, MAX_RECORDS)) {
      try {
        const rec = cleanRecord(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')));
        if (rec && name === rec.entryId + '.json') records.set(rec.entryId, rec);
      } catch { /* a damaged record unlocks nothing; the end of the trial deletes it */ }
    }
  }

  async function writeRecord(rec) {
    await fsp.mkdir(dir, { recursive: true });
    const widgets = rec.widgets.map((w) => ({ id: w.id, manifest: w.raw, accepted: w.accepted }));
    await writeFileAtomic(fileOf(rec.entryId), JSON.stringify({ ...rec, widgets }));
  }

  // Which record owns an accepted id: the newest one, when two drops share it.
  function ownerOf(id) {
    let best = null;
    for (const rec of records.values()) {
      if (rec.widgets.some((w) => w.id === id && w.accepted) && (!best || rec.at >= best.at)) best = rec;
    }
    return best;
  }

  // Serving needs the hub's word that the trial runs; after a conversion the
  // content stays up until it has been installed for good.
  async function serving() {
    const st = (await trialPass.status()).state;
    return st === 'active' || st === 'converted';
  }

  // A trial redeem just succeeded: keep the locked file, open it in memory, and
  // hand the dashboard the inner code with markers instead of packages.
  async function open({ entryId, kv, enc, cek, catalogVersion }) {
    const inner = decryptEnvelope(enc, cek);
    if (!inner) return { ok: false, error: 'bad_request' };
    const stub = stubInner(inner);
    if (!stub) return { ok: false, error: 'bad_request' };
    const pkgs = packagesOf(inner);
    if (!pkgs.size) return { ok: true, inner: stub };
    return serial(async () => {
      const prev = records.get(entryId);
      if (!prev && records.size >= MAX_RECORDS) return { ok: false, error: 'bad_request' };
      const rec = cleanRecord({
        entryId, kv, enc, catalogVersion, at: now(),
        widgets: [...pkgs.values()].map((v) => ({
          id: v.id, manifest: rawManifest(v),
          accepted: !!(prev && prev.widgets.some((w) => w.id === v.id && w.accepted)),
        })),
      });
      if (!rec) return { ok: false, error: 'bad_request' };
      await writeRecord(rec);
      records.set(entryId, rec);
      opened.set(entryId, pkgs);
      return { ok: true, inner: stub };
    });
  }

  // The import flow confirmed a package: it is now listed and served.
  async function accept(id) {
    if (!WIDGET_ID_RE.test(String(id || '')) || !(await serving())) return { ok: false, error: 'not_found' };
    return serial(async () => {
      let rec = null;
      for (const r of records.values()) if (opened.get(r.entryId)?.has(id) && (!rec || r.at >= rec.at)) rec = r;
      if (!rec) return { ok: false, error: 'not_found' };
      rec.widgets = rec.widgets.map((w) => (w.id === id ? { ...w, accepted: true } : w));
      await writeRecord(rec);
      changed();
      const m = rec.widgets.find((w) => w.id === id).manifest;
      return { ok: true, id, name: m.name, actions: m.actions, streams: m.streams, hosts: m.hosts };
    });
  }

  // For the package scan: the accepted manifests, while the trial runs.
  async function packages() {
    if (!(await serving())) return [];
    const out = new Map();
    for (const rec of records.values()) {
      for (const w of rec.widgets) if (w.accepted && ownerOf(w.id) === rec) out.set(w.id, w.manifest);
    }
    return [...out.values()];
  }

  // Origin lookups are synchronous; the index is in memory.
  const has = (id) => !!ownerOf(id);

  // Asks the hub for the keys of the records not open yet, one at a time, and
  // not more often than RETRY_GAP_MS: a refused redeem makes the trial ask the
  // hub, which syncs the vault again, and that must not turn into a loop.
  async function loadAll() {
    if (now() - lastTry < RETRY_GAP_MS) return;
    lastTry = now();
    for (const rec of [...records.values()]) {
      if (opened.has(rec.entryId)) continue;
      let r = null;
      try { r = await redeem({ entryId: rec.entryId, kv: rec.kv, viaTrial: true }); } catch { r = null; }
      const inner = r && r.ok ? decryptEnvelope(rec.enc, r.cek) : null;
      if (inner) { opened.set(rec.entryId, packagesOf(inner)); continue; }
      if (r && DEAD_ENTRY_ERRORS.has(r.error)) await dropRecord(rec.entryId);
      if (!r || r.error === 'rate_limited' || r.error === 'network') break;   // the next try asks again
    }
  }

  // A request for a closed trial package is also what moves the vault along: it
  // opens what a failed start left closed, or retries a conversion that could not
  // finish (after a restart the trial code no longer opens anything).
  async function ensureOpen(rec, state) {
    if (state === 'converted') {
      if (now() - lastPromote < RETRY_GAP_MS) return;
      lastPromote = now();
      await serial(promote);
    } else await serial(loadAll);
  }

  // One file of an accepted trial package, or null (unknown, or not served now).
  async function asset(id, relPath) {
    const rec = ownerOf(String(id || ''));
    const state = (await trialPass.status()).state;
    if (!rec || !(state === 'active' || state === 'converted')) return null;
    const abs = sdkWidgets.resolveAsset(VIRTUAL_ROOT, id, relPath);
    if (!abs) return null;
    const rel = path.relative(path.join(VIRTUAL_ROOT, id), abs).split(path.sep).join('/');
    // What is open in memory is served first; only a closed record waits for the hub.
    if (!opened.has(rec.entryId)) await ensureOpen(rec, state);
    const pkg = opened.get(rec.entryId)?.get(id);
    const file = pkg && pkg.files.find((f) => f.relPath === rel);
    return file ? { bytes: file.bytes, mime: sdkWidgets.mimeFor(rel) } : null;
  }

  async function dropRecord(entryId) {
    records.delete(entryId);
    opened.delete(entryId);
    try { await fsp.rm(fileOf(entryId), { force: true }); } catch { /* retried at the next sync */ }
  }

  // The user removed the package: it is no longer listed, here or after a restart.
  function remove(id) {
    return serial(async () => {
      for (const rec of [...records.values()]) {
        if (!rec.widgets.some((w) => w.id === id)) continue;
        rec.widgets = rec.widgets.map((w) => (w.id === id ? { ...w, accepted: false } : w));
        if (rec.widgets.some((w) => w.accepted)) await writeRecord(rec); else await dropRecord(rec.entryId);
      }
      changed();
    });
  }

  // The trial converted: redeem each drop with the supporter pass (so the hub
  // records this install as an owner) and install what was in use for good.
  async function promote() {
    for (const rec of [...records.values()]) {
      let r = null;
      try { r = await redeem({ entryId: rec.entryId, kv: rec.kv }); } catch { r = null; }
      if (!r || !r.ok) {
        if (r && (DEAD_ENTRY_ERRORS.has(r.error) || r.error === 'expired' || r.error === 'bad_code')) await dropRecord(rec.entryId);
        continue;   // network, rate limit, pass not saved yet: the next sync tries again
      }
      const pkgs = packagesOf(decryptEnvelope(rec.enc, r.cek));
      let failed = false;
      for (const w of rec.widgets.filter((x) => x.accepted)) {
        const v = pkgs.get(w.id);
        const out = v ? await installPayload(toPayload(v), rec.catalogVersion) : null;
        if (!out || !out.ok) failed = true;
      }
      if (!failed) await dropRecord(rec.entryId);
    }
  }

  // Follows the trial's state: open while it runs, install on conversion, delete
  // when it ended or no trial is left on this install.
  function sync() {
    return serial(async () => {
      const st = (await trialPass.status()).state;
      if (st === 'active') await loadAll();
      else if (st === 'converted') { lastPromote = now(); await promote(); }
      else if (st === 'unverified') opened.clear();
      else {
        for (const entryId of [...records.keys()]) await dropRecord(entryId);
        // Files it could not read (damaged, renamed) go with the rest.
        try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* retried at the next sync */ }
      }
      changed();
    });
  }

  return { init, open, accept, packages, has, asset, remove, sync };
}

// The package's own manifest.json, as stored: normalizeManifest is the boundary
// on the way back in, and it reads the author's shape, not its own output.
function rawManifest(v) {
  return JSON.parse(v.files.find((f) => f.relPath === 'manifest.json').bytes.toString('utf8'));
}

// A validated package back in the /sdk/install payload shape.
function toPayload(v) {
  return { id: v.id, files: v.files.map((f) => ({ path: f.relPath, data: f.bytes.toString('base64') })) };
}

module.exports = { createTrialVault, decryptEnvelope, stubInner, packagesOf };
