'use strict';

// The 7-day supporter-pass trial on this install. The hub owns the truth: it
// binds an XT code to ONE install at its first /redeem, starts the 7 days on its
// own clock and says whether the trial still runs (POST /trial/status). This
// module only remembers the code and the hub's last answer, in DATA_DIR (never
// settings.json, which travels to every surface and paired phone).
//
//   - Deleting the file gives nothing: the hub allows one trial per install.
//   - The local clock cannot stretch it: `active` is the hub's word, trusted for
//     48 hours, and an answer stamped in the future (clock moved back) is stale.
//   - An unverified trial (offline for more than 48 hours) is paused, not ended:
//     content comes off only when the hub said it ended, or its fixed end passed.
//   - When the trial address becomes a supporter, the hub hands the XS code over
//     once; it is saved as this PC's pass, so the switch needs no typing.
//
// What the trial installed stays on disk like any unlock, marked as trial in its
// install receipt; the dashboard takes it off at the end (js/trial-pass-ui.js)
// and records what was tried here, so a later conversion can put it back.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');

const FILE = 'trial-pass.json';
const TRIAL_CODE_RE = /^XT[A-Z0-9]{12}$/;
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TILE_KEY_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const HOUR = 60 * 60 * 1000;
const TRUST_MS = 48 * HOUR;
const CHECK_EVERY_MS = 24 * HOUR;
// The hub forgets an ended trial's code after 30 days; asking later is pointless.
const ASK_AFTER_END_MS = 30 * 24 * HOUR;
// A dashboard opening asks for fresh news, but the hub is asked at most this often.
const REFRESH_GAP_MS = 10 * 60 * 1000;
// A dashboard that claimed the clean-up is given this long to finish it before
// another one treats the end as done and tidies whatever it still sees.
const END_GRACE_MS = 10 * 60 * 1000;
const PENDING_CODE_RE = /^[A-Z0-9]{8,40}$/;
const MAX_TRIED = 64;
const MAX_LIST = 32;

const ids = (list, re) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && re.test(v)).slice(0, MAX_LIST) : []);

function cleanTried(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !ENTRY_ID_RE.test(String(raw.entryId || ''))) continue;
    if (out.some((t) => t.entryId === raw.entryId)) continue;
    out.push({
      entryId: raw.entryId,
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '',
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 20) : '',
      widgetIds: ids(raw.widgetIds, WIDGET_ID_RE),
      tiles: ids(raw.tiles, TILE_KEY_RE),
    });
    if (out.length >= MAX_TRIED) break;
  }
  return out;
}

function cleanState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (!TRIAL_CODE_RE.test(String(s.code || ''))) return { code: '', tried: [] };
  return {
    code: s.code,
    expiresAt: Number.isFinite(s.expiresAt) ? s.expiresAt : 0,
    lastOkAt: Number.isFinite(s.lastOkAt) ? s.lastOkAt : 0,
    active: s.active === true,
    converted: s.converted === true,
    // A dashboard already took the trial content off (only one does).
    endDone: s.endDone === true,
    endClaimedAt: Number.isFinite(s.endClaimedAt) ? s.endClaimedAt : 0,
    // The supporter code the hub handed over, kept here only while saving it
    // as this PC's pass keeps failing: the hub hands it over once.
    pendingCode: PENDING_CODE_RE.test(String(s.pendingCode || '')) ? s.pendingCode : '',
    tried: cleanTried(s.tried),
  };
}

function createTrialPass({
  dataDir,
  post = supporterRedeem.hubPost,
  scopedId = () => supporterRedeem.getScopedId(dataDir, supporterRedeem.SCOPE_DEVICES),
  saveSupporterCode = (code) => supporterRedeem.saveTypedCode(dataDir, code),
  now = Date.now,
  // Told after every look at the hub, so what follows the trial's state (the
  // widget vault) follows it too.
  onCheck = () => {},
}) {
  let cache = null;
  let writing = Promise.resolve();
  let timer = null;
  let stopped = false;

  async function load() {
    if (cache) return cache;
    try { cache = cleanState(JSON.parse(await fsp.readFile(path.join(dataDir, FILE), 'utf8'))); }
    catch { cache = cleanState(null); }
    return cache;
  }

  // One write at a time, so a check and a redeem landing together never lose a field.
  function save(change) {
    const run = writing.then(async () => {
      const next = cleanState(change(await load()));
      await writeFileAtomic(path.join(dataDir, FILE), JSON.stringify(next));
      cache = next;
    });
    writing = run.catch(() => {});
    return run;
  }

  const endMs = (s) => s.expiresAt * 1000;
  const trusted = (s) => s.lastOkAt <= now() && now() - s.lastOkAt < TRUST_MS;

  function phase(s) {
    if (!s.code) return 'none';
    if (s.converted) return 'converted';
    if (!s.active || now() >= endMs(s)) return 'ended';
    return trusted(s) ? 'active' : 'unverified';
  }

  async function isActive() {
    return phase(await load()) === 'active';
  }

  // The code for a redeem the user typed nothing into, while the trial runs.
  async function activeCode() {
    const s = await load();
    return phase(s) === 'active' ? s.code : '';
  }

  // What the dashboard may know. Never the code.
  async function status() {
    const s = await load();
    const state = phase(s);
    return {
      ok: true,
      state,
      used: state !== 'none',
      endsAt: s.code ? endMs(s) : null,
      // Settled: claimed long enough ago that the claimer finished or gave up.
      endDone: !!s.endDone && !(s.endClaimedAt <= now() && now() - s.endClaimedAt < END_GRACE_MS),
      tried: s.tried,
    };
  }

  // After an XT redeem the hub accepted: it bound the trial to this install.
  async function remember(code, trialEndsAt) {
    if (!TRIAL_CODE_RE.test(String(code || '')) || !Number.isFinite(trialEndsAt)) return;
    await save((cur) => ({
      code, expiresAt: trialEndsAt, lastOkAt: now(), active: true, converted: false,
      endDone: cur.code === code && cur.endDone,
      endClaimedAt: cur.code === code ? cur.endClaimedAt : 0,
      tried: cur.code === code ? cur.tried : [],
    }));
    schedule();
  }

  // Saves the handed-over supporter code as this PC's pass; on failure it stays
  // pending in this file and the next look tries again.
  async function storeSupporterCode(code) {
    let saved = null;
    try { saved = await saveSupporterCode(code); } catch { saved = null; }
    const ok = !!(saved && saved.ok);
    await save((cur) => ({ ...cur, pendingCode: ok ? '' : String(code).toUpperCase().replace(/[^A-Z0-9]/g, '') }));
    return ok;
  }

  async function flushPending() {
    const s = await load();
    if (s.pendingCode) await storeSupporterCode(s.pendingCode);
  }

  async function check() {
    const s = await load();
    if (!s.code) return status();
    await flushPending();
    let out;
    try { out = await post('/trial/status', { code: s.code, scopedId: await scopedId() }); }
    catch { out = null; }
    if (out && out.ok === true) {
      // Save the handed-over code FIRST: the hub gives it only once.
      if (typeof out.supporterCode === 'string' && out.supporterCode) await storeSupporterCode(out.supporterCode);
      await save((cur) => ({
        ...cur,
        active: out.active === true,
        // The hub's word, not sticky: a file edited to say "converted" is
        // corrected on the next answer.
        converted: out.converted === true,
        expiresAt: Number.isFinite(out.expiresAt) ? out.expiresAt : cur.expiresAt,
        lastOkAt: now(),
      }));
    } else if (out && out.error === 'bad_code') {
      // The hub no longer knows this trial for this install: it is over.
      await save((cur) => ({ ...cur, active: false }));
    }
    schedule();
    try { onCheck(); } catch { /* a listener never fails the check */ }
    return status();
  }

  // What a dashboard calls when it opens: the hub's latest word, without asking
  // it again when it answered a few minutes ago.
  async function refresh() {
    await flushPending();
    const s = await load();
    if (!s.code || s.converted) return status();
    const age = now() - s.lastOkAt;
    if (age >= 0 && age < REFRESH_GAP_MS) return status();
    return check();
  }

  // The dashboard records what it took off at the end, so a conversion can put it
  // back, and claims the clean-up: several surfaces may notice the end at once,
  // and only the first one (claimed: true) takes the content off. Only once the
  // trial really ended, so nobody can mark a running trial as cleaned up.
  async function setTried(list, { end = false } = {}) {
    const s = await load();
    if (!s.code) return { ok: false, error: 'no_trial' };
    if (!end || phase(s) !== 'ended') return { ok: false, error: 'not_ended' };
    let claimed = false;
    await save((cur) => {
      claimed = !cur.endDone && phase(cur) === 'ended';
      if (!claimed) return cur;
      return { ...cur, tried: cleanTried(list), endDone: true, endClaimedAt: now() };
    });
    return { ...(await status()), claimed };
  }

  // Next look at the hub: at the trial's end, else daily, until it converted or
  // the hub forgot the code. Only while a trial exists; unref'd, stopped on shutdown.
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || !cache || !cache.code || cache.converted) return;
    const end = endMs(cache);
    if (now() > end + ASK_AFTER_END_MS) return;
    const untilEnd = end - now();
    const delay = untilEnd > 0 ? Math.min(CHECK_EVERY_MS, untilEnd + 5000) : CHECK_EVERY_MS;
    timer = setTimeout(() => { timer = null; check().catch(() => {}); }, delay);
    if (timer.unref) timer.unref();
  }

  async function start() {
    stopped = false;
    const s = await load();
    if (s.code) await check();
    else await flushPending();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { isActive, activeCode, status, remember, check, refresh, setTried, start, stop };
}

module.exports = { createTrialPass, TRIAL_CODE_RE, TRUST_MS };
