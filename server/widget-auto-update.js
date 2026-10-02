'use strict';

// ── Automatic widget updates ─────────────────────────────────────────────────
// Brings the Store widgets a user installed up to the version the catalog lists,
// by itself, through the SAME boundary a manual update uses (the validated
// /sdk/install payload, never auto-granted). It only decides WHEN and WHETHER;
// every byte is still validated by sdk-widgets.js before it is written.
//
// Two halves, so the part that decides can be tested exhaustively:
//   planUpdates(...)              pure: which installed widgets are due, and why not the rest
//   exceedsGrants(...)            pure: would the new version ask for more than was approved
//   createWidgetAutoUpdater(deps) the loop around them, every effect injected
//
// The rules, and why each exists:
//   - Off when the user switched it off; nothing at all in safe mode.
//   - Only widgets that came from the catalog (an install stamped with the catalog
//     entry's version) and are still the user's import. A folder someone built by
//     hand, a package the user created, and a widget that arrived inside a bundle
//     are never touched: we cannot say what "the newer version" of those would be.
//   - A version is only taken once a full UTC day has passed after the day it was
//     published (2 days from its stamp, so at least 24 hours whatever the hour).
//     The catalog entry is reviewed before it is published, and this is the time to
//     pull one that turned out wrong; hiding the entry stops it reaching anyone.
//   - NEVER when the new version asks for anything the user has not already
//     approved: a new stream, action, host, hook, handler, capability or address
//     slot, or a changed surface. Approving is a decision, and it stays manual:
//     the update is offered as always and the user is told it is waiting.
//   - A widget the user suspended stays exactly as it is.
//   - The package identity is re-checked after decoding: the entry's pkgId must be
//     the id inside the payload, so a catalog row cannot overwrite another widget.
//   - A supporter (locked) widget is unlocked with the supporter pass already saved
//     on this PC, exactly as the dashboard would. With no usable pass it is left
//     for the user, who is told. The pass is never typed, guessed or sent anywhere
//     but the hub's redeem endpoint.
//   - The swap is atomic with a rollback (sdk-widgets.installPackageStaged): the
//     package is the old version whole, or the new one whole.
//   - A version that failed once is never retried automatically; the manual
//     update stays available.
//   - Not while a game, Performance Mode, a call, a live voice session or a file
//     transfer is going on, and at most a few widgets per run.

const crypto = require('crypto');
const { semverNewer } = require('./semver');

const DAY_MS = 24 * 60 * 60 * 1000;
// A catalog date is a day, not a moment. Two days after it is at least 24 hours
// after the entry went live, whatever time of that day it was published.
const MIN_AGE_AFTER_STAMP_MS = 2 * DAY_MS;
const FIRST_TICK_MS = 4 * 60 * 1000;
const TICK_MS = 6 * 60 * 60 * 1000;
const SETTINGS_ON_DELAY_MS = 20 * 1000;
const MAX_PER_RUN = 6;
const MAX_FAILED = 200;
const MAX_LAST = 20;
const PKG_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// ── pure: would the new manifest ask for more than the user approved? ─────────
// Mirrors grantNeedsReview() in js/custom-widget.js, which stays the authority on
// the dashboard: test/widget-auto-update.test.mjs evaluates that function against
// this one on the same inputs, so the two cannot drift. `prev` is the manifest of
// the installed version (for the things a grant cannot express: address slots and
// the surface the package renders on).
function exceedsGrants(manifest, grants, prev) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const g = grants && typeof grants === 'object' ? grants : {};
  const list = (o, k) => (Array.isArray(o[k]) ? o[k] : []);
  const handlers = (m.deck && Array.isArray(m.deck.handlers)) ? m.deck.handlers.map((h) => h && h.id) : [];
  if (list(m, 'streams').some((s) => !list(g, 'streams').includes(s))) return 'streams';
  if (list(m, 'actions').some((a) => !list(g, 'actions').includes(a))) return 'actions';
  if (list(m, 'hosts').some((h) => !list(g, 'hosts').includes(h))) return 'hosts';
  if (list(m, 'hooks').some((h) => !list(g, 'hooks').includes(h))) return 'hooks';
  if (handlers.some((h) => !list(g, 'handlers').includes(h))) return 'handlers';
  for (const flag of ['storage', 'secrets', 'island', 'islandDynamic', 'islandFull', 'badge', 'badgeAction', 'mini', 'clipboard', 'accent', 'expand']) {
    if (m[flag] === true && g[flag] !== true) return flag;
  }
  if (prev && typeof prev === 'object') {
    // A new blank for an address is a new place the widget wants to reach.
    const had = new Set((Array.isArray(prev.userHosts) ? prev.userHosts : []).map((u) => u && u.id));
    if ((Array.isArray(m.userHosts) ? m.userHosts : []).some((u) => !had.has(u && u.id))) return 'userHosts';
    if ((prev.surface || 'tile') !== (m.surface || 'tile')) return 'surface';
  }
  return '';
}

// ── pure: which installed widgets are due ────────────────────────────────────
// Returns { due: [{ entry, pkg }], waiting: n }. `waiting` counts the updates the
// catalog offers that are not due yet (too fresh), so the status can say so.
function planUpdates(ctx) {
  const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
  const installed = new Map((Array.isArray(ctx.installed) ? ctx.installed : []).map((p) => [p.id, p]));
  const failed = ctx.failed && typeof ctx.failed === 'object' ? ctx.failed : {};
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const due = [];
  let waiting = 0;
  for (const e of entries) {
    if (!e || (e.kind !== 'widget' && e.kind !== 'ambient') || !e.version) continue;
    if (!PKG_ID_RE.test(String(e.pkgId || ''))) continue;
    const pkg = installed.get(e.pkgId);
    if (!pkg) continue;
    if (ctx.originOf(e.pkgId) !== 'import') continue;               // only what arrived as an import
    const stamp = ctx.catalogVersionOf(e.pkgId);
    if (!stamp || !semverNewer(e.version, stamp)) continue;          // not installed from the catalog, or current
    if (ctx.isSuspended(e.pkgId)) continue;
    if (failed[e.pkgId + '@' + e.version]) continue;                 // failed once: manual only
    if (e.appVersionMin && semverNewer(e.appVersionMin, ctx.appVersion)) continue;   // needs a newer Xenon
    const day = Date.parse(String(e.updatedAt || e.addedAt || '') + 'T00:00:00Z');
    if (!Number.isFinite(day)) continue;                             // no date, no proof of age
    if (now < day + MIN_AGE_AFTER_STAMP_MS) { waiting++; continue; }
    due.push({ entry: e, pkg });
  }
  return { due, waiting };
}

// ── decrypt a remote-locked (v2) code with the key the hub returned ──────────
// Same AES-GCM the dashboard uses (WebCrypto's ciphertext carries the 16-byte tag
// at the end). Done with node:crypto so this does not depend on a global `crypto`.
function decryptRemote(locked, cekB64) {
  try {
    const key = Buffer.from(String(cekB64 || ''), 'base64');
    const iv = Buffer.from(String(locked && locked.enc && locked.enc.iv || ''), 'base64');
    const ct = Buffer.from(String(locked && locked.enc && locked.enc.ct || ''), 'base64');
    if (key.length !== 32 || iv.length !== 12 || ct.length < 17) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
  } catch { return null; }
}

function createWidgetAutoUpdater(deps) {
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());
  let timer = null;
  let running = false;
  let stopped = false;
  let state = null;   // { failed:{}, announced:{}, last:{at,updated:[]}, pending:{} }

  async function load() {
    if (state) return state;
    let raw = null;
    try { raw = await deps.store.read(); } catch { raw = null; }
    const o = raw && typeof raw === 'object' ? raw : {};
    state = {
      failed: o.failed && typeof o.failed === 'object' && !Array.isArray(o.failed) ? o.failed : {},
      announced: o.announced && typeof o.announced === 'object' && !Array.isArray(o.announced) ? o.announced : {},
      last: o.last && typeof o.last === 'object' ? o.last : { at: '', updated: [] },
      pending: o.pending && typeof o.pending === 'object' && !Array.isArray(o.pending) ? o.pending : {},
    };
    return state;
  }
  async function save() {
    if (!state) return;
    const trim = (obj, max) => {
      const keys = Object.keys(obj);
      if (keys.length <= max) return obj;
      const out = {};
      keys.slice(keys.length - max).forEach((k) => { out[k] = obj[k]; });
      return out;
    };
    state.failed = trim(state.failed, MAX_FAILED);
    state.announced = trim(state.announced, MAX_FAILED);
    try { await deps.store.write(state); } catch (e) { log('could not save state: ' + (e && e.message)); }
  }

  // One candidate. Returns { updated }, { attention: reason } or { failed: reason } or
  // { skip: reason } (a transient problem: try again next time, nothing recorded).
  async function applyOne({ entry, pkg }) {
    const codeRes = await deps.fetchCode(entry.id);
    if (!codeRes || !codeRes.ok || !codeRes.code) return { skip: 'code_unavailable' };
    let inner = String(codeRes.code);
    const locked = deps.codec.peekLocked(inner);
    if (locked) {
      if (!locked.remote || locked.entryId !== entry.id) return { attention: 'needs_code' };
      // An install the hub already knows as an owner is updated with no code at all
      // (it is how a purchased widget updates by itself); anything else, including a
      // hub that does not know this install, falls through to the saved pass below.
      let key = null;
      if (typeof deps.update === 'function') {
        let u = null;
        try { u = await deps.update(entry.id, { have: pkg.catalogVersion || pkg.version || '', kv: locked.kv || null }); } catch { u = null; }
        if (u && u.ok === true && typeof u.cek === 'string' && u.cek) key = u.cek;
        else if (u && u.error === 'network') return { skip: 'network' };
      }
      if (!key) {
        const r = await deps.redeem(entry.id, locked.kv || null);   // the pass saved on this PC; never a typed one
        if (!r || !r.ok) {
          if (r && r.error === 'network') return { skip: 'network' };
          return { attention: 'needs_code' };
        }
        key = r.cek;
      }
      inner = decryptRemote(locked, key);
      if (!inner) return { failed: 'unlock_failed' };
    }
    const env = deps.codec.decodePreset(inner);
    if (!env || env.kind !== entry.kind) return { failed: 'bad_code' };
    const payload = (env.data && env.data.payload) || env.data;
    const v = deps.validatePayload(payload);
    if (!v || !v.ok) return { failed: 'invalid_package' };
    if (v.id !== entry.pkgId) return { failed: 'identity_mismatch' };
    const over = exceedsGrants(v.manifest, deps.grantsOf(entry.pkgId), pkg);
    if (over) return { attention: 'needs_approval:' + over };
    const res = await deps.installStaged(v, entry.version);
    if (!res || !res.ok) return { failed: (res && res.error) || 'install_failed' };
    return { updated: true, name: v.manifest.name || pkg.name || entry.pkgId, from: pkg.version || '' };
  }

  async function runOnce() {
    if (running || stopped) return { ok: false, skipped: 'busy' };
    if (!deps.isEnabled()) return { ok: true, skipped: 'off' };
    if (deps.safeMode()) return { ok: true, skipped: 'safe_mode' };
    running = true;
    try {
      const sig = await deps.signals();
      if (sig && Array.isArray(sig.blockers) && sig.blockers.length) return { ok: true, skipped: 'busy:' + sig.blockers[0] };
      const cat = await deps.fetchCatalog();
      if (!cat || !cat.ok || !Array.isArray(cat.entries)) return { ok: false, skipped: 'catalog_unavailable' };
      const st = await load();
      const plan = planUpdates({
        entries: cat.entries,
        installed: await deps.listInstalled(),
        originOf: deps.originOf,
        catalogVersionOf: deps.catalogVersionOf,
        isSuspended: deps.isSuspended,
        failed: st.failed,
        appVersion: deps.currentVersion,
        now: now(),
      });
      const updated = [];
      const attention = [];
      let touched = false;
      for (const cand of plan.due.slice(0, MAX_PER_RUN)) {
        if (stopped || !deps.isEnabled()) break;
        let out;
        try { out = await applyOne(cand); } catch (e) { out = { failed: 'error' }; log('error on ' + cand.entry.pkgId + ': ' + (e && e.message)); }
        const id = cand.entry.pkgId;
        const stamp = id + '@' + cand.entry.version;
        if (out.updated) {
          updated.push({ id, name: out.name, from: out.from, to: cand.entry.version });
          delete st.pending[id];
          touched = true;
          log('updated ' + id + ' ' + out.from + ' -> ' + cand.entry.version);
        } else if (out.failed) {
          st.failed[stamp] = new Date(now()).toISOString();
          touched = true;
          log('failed ' + stamp + ': ' + out.failed + ' (manual update only from now on)');
        } else if (out.attention) {
          st.pending[id] = { version: cand.entry.version, reason: out.attention, name: cand.pkg.name || id };
          // Said once per version: the same sentence every six hours would be noise.
          if (!st.announced[stamp]) { st.announced[stamp] = new Date(now()).toISOString(); attention.push({ id, name: cand.pkg.name || id, version: cand.entry.version, reason: out.attention }); }
          touched = true;
        }
      }
      if (updated.length) {
        st.last = { at: new Date(now()).toISOString(), updated: updated.concat(st.last.updated || []).slice(0, MAX_LAST) };
      }
      if (touched) await save();
      if (updated.length || attention.length) deps.broadcast('widget_auto_updated', { updated, attention });
      return { ok: true, updated: updated.length, attention: attention.length, waiting: plan.waiting };
    } finally { running = false; }
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await runOnce(); } catch (e) { log('run failed: ' + (e && e.message)); }
      schedule(TICK_MS);
    }, ms);
    if (timer.unref) timer.unref();
  }

  return {
    async start() { stopped = false; schedule(FIRST_TICK_MS); },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    // The switch was turned on: do not make the user wait for the six-hour tick.
    settingsChanged() { if (deps.isEnabled()) schedule(SETTINGS_ON_DELAY_MS); },
    runOnce,
    async status() {
      const st = await load();
      return {
        enabled: !!deps.isEnabled(),
        last: st.last && st.last.at ? { at: st.last.at, updated: (st.last.updated || []).slice(0, 5) } : null,
        waitingForYou: Object.keys(st.pending).map((id) => ({ id, name: st.pending[id].name, version: st.pending[id].version, reason: st.pending[id].reason })),
      };
    },
  };
}

module.exports = {
  createWidgetAutoUpdater,
  planUpdates,
  exceedsGrants,
  decryptRemote,
  MIN_AGE_AFTER_STAMP_MS,
  MAX_PER_RUN,
};
