'use strict';

// Performance Mode settings: the activity list, the defaults and the
// normalizer. One copy for every page that runs Performance Mode: the
// dashboard (before js/settings.js, which uses them for hubSettings), the
// "widgets only" driver page (js/driver-perf.js, without settings.js) and the
// server, which checks what the driver saves (POST /api/performance/state).
// Classic-script declarations on purpose: settings.js and performance.js read
// them as shared globals.

// The activities Performance Mode can detect and react to. One list, used by
// the normalizers, the settings toggles, and the trigger-app editor.
const PERF_ACTIVITIES = ['gaming', 'coding', 'writing', 'streaming', 'creating', 'meeting'];

// Performance Mode (opt-in, off by default). Broader than gameMode: a
// user-triggered / suggested profile that pauses dashboard animations and
// applies reversible system tweaks (power plan) with confirmation. See
// docs/superpowers/specs/performance-mode.md.
const PERF_DEFAULTS = Object.freeze({
  enabled: false,        // master opt-in
  autoSuggest: true,     // show a banner when a tracked activity is detected
  // 'suggest' shows the banner + confirmation sheet; 'auto' applies the safe,
  // reversible tweaks (animations, power plan, priority) by itself when an
  // enabled activity starts and restores them when it ends. App closing is
  // NEVER automatic — it always goes through the sheet.
  autoMode: 'suggest',
  // Which detected activities trigger the auto-suggest banner. Gaming only by
  // default — the others are opt-in so the suggestion never nags during
  // normal desk work unless the user wants it.
  autoActivities: Object.freeze({ gaming: true, coding: false, writing: false, streaming: false, creating: false, meeting: false }),
  useAi: true,           // let Xenon AI drive the decisions (when a provider is configured)
  // The top bar button: false shows it only while a session runs (to see it and
  // turn it off), true keeps it there to start one at any time.
  barAlways: false,
  active: false,         // runtime: an optimization session is currently applied
  activatedBy: '',       // runtime: '' | 'manual' | 'auto' — auto sessions auto-restore
  autoActivity: '',      // runtime: the activity that auto-applied the session
  savedPowerPlan: '',    // GUID of the user's power plan before we switched (for restore)
  closedApps: [],        // runtime: apps we closed this session, for one-tap reopen
  // Learning: per-app keep/close counters from the user's sheet choices, used
  // to bias future preselection toward what this user actually does.
  appChoices: Object.freeze({}),
  // runtime: what was actually applied this session (the sheet lets the user
  // pick per-run, so this can differ from `opts`). Drives restore + perf-mode.
  applied: Object.freeze({ pauseAnimations: false, powerPlan: 'none', boostedProc: '' }),
  opts: Object.freeze({
    pauseAnimations: true, // pause dashboard animations + background FX (reversible)
    powerPlan: 'high',     // 'none' | 'high' | 'ultimate' — Windows power scheme to apply
    manageApps: false,     // offer to close chosen background apps (opt-in, high-touch)
    priorityBoost: false,  // nudge the active app's process priority up (reversible)
    pauseStreams: true,    // pause heavy live tiles (Browser, future second screen) while gaming/optimizing
  }),
  // User customization of the per-activity trigger app lists, relative to the
  // built-in defaults: `add` extends, `remove` drops a default. Process names,
  // lowercase, no extension.
  activityApps: Object.freeze({
    gaming:  Object.freeze({ add: [], remove: [] }),
    coding:  Object.freeze({ add: [], remove: [] }),
    writing: Object.freeze({ add: [], remove: [] }),
  }),
});

function normalizePerformance(value) {
  const d = PERF_DEFAULTS;
  const v = value && typeof value === 'object' ? value : {};
  const o = v.opts && typeof v.opts === 'object' ? v.opts : {};
  const powerPlan = ['none', 'high', 'ultimate'].includes(o.powerPlan) ? o.powerPlan : d.opts.powerPlan;
  const savedPowerPlan = (typeof v.savedPowerPlan === 'string'
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v.savedPowerPlan))
    ? v.savedPowerPlan.toLowerCase() : '';
  // Closed-app records (for one-tap reopen). Keep only the fields we need, and
  // only entries with a launchable executable path; cap the list defensively.
  const closedApps = (Array.isArray(v.closedApps) ? v.closedApps : [])
    .filter(a => a && typeof a === 'object' && typeof a.path === 'string' && /\.(exe|lnk)$/i.test(a.path))
    .slice(0, 30)
    .map(a => ({ name: String(a.name || '').slice(0, 80), path: a.path.slice(0, 1024) }));
  const aa = v.autoActivities && typeof v.autoActivities === 'object' ? v.autoActivities : {};
  const dAA = PERF_DEFAULTS.autoActivities;
  const autoActivities = {};
  for (const act of PERF_ACTIVITIES) {
    autoActivities[act] = typeof aa[act] === 'boolean' ? aa[act] : !!dAA[act];
  }
  const ap = v.applied && typeof v.applied === 'object' ? v.applied : {};
  const appliedPlan = ['none', 'high', 'ultimate'].includes(ap.powerPlan) ? ap.powerPlan : 'none';
  return {
    enabled: v.enabled === true,
    autoSuggest: v.autoSuggest !== false,
    autoMode: v.autoMode === 'auto' ? 'auto' : 'suggest',
    autoActivities,
    useAi: v.useAi !== false,
    barAlways: v.barAlways === true,
    active: v.active === true,
    activatedBy: ['manual', 'auto'].includes(v.activatedBy) ? v.activatedBy : '',
    autoActivity: PERF_ACTIVITIES.includes(v.autoActivity) ? v.autoActivity : '',
    savedPowerPlan,
    closedApps,
    appChoices: normalizePerfAppChoices(v.appChoices),
    applied: {
      pauseAnimations: ap.pauseAnimations === true,
      powerPlan: appliedPlan,
      boostedProc: (typeof ap.boostedProc === 'string' && /^[\w.+\- ]{1,60}$/.test(ap.boostedProc)) ? ap.boostedProc : '',
    },
    opts: {
      pauseAnimations: o.pauseAnimations !== false,
      powerPlan,
      manageApps: o.manageApps === true,
      priorityBoost: o.priorityBoost === true,
      pauseStreams: o.pauseStreams !== false,
    },
    activityApps: normalizeActivityApps(v.activityApps),
  };
}

// Sanitize a list of process names: lowercase, no extension, safe chars only,
// deduped and capped. Shared by the per-activity add/remove lists.
function normalizeAppNameList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const n = String(raw == null ? '' : raw).toLowerCase().trim().replace(/\.exe$/, '');
    if (!/^[a-z0-9._+\-]{1,40}$/.test(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 40) break;
  }
  return out;
}

function normalizeActivityApps(value) {
  const v = value && typeof value === 'object' ? value : {};
  const one = (a) => {
    const x = a && typeof a === 'object' ? a : {};
    return { add: normalizeAppNameList(x.add), remove: normalizeAppNameList(x.remove) };
  };
  const out = {};
  for (const act of PERF_ACTIVITIES) out[act] = one(v[act]);
  return out;
}

// Per-app keep/close counters (learning from the sheet choices). Keys are bare
// lowercase process names; counts are small bounded ints; the map is capped.
function normalizePerfAppChoices(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    const name = String(key).toLowerCase().trim().replace(/\.exe$/, '');
    if (!/^[a-z0-9._+\- ]{1,40}$/.test(name)) continue;
    const c = v[key] && typeof v[key] === 'object' ? v[key] : {};
    const kept = Math.min(99, Math.max(0, parseInt(c.kept, 10) || 0));
    const closed = Math.min(99, Math.max(0, parseInt(c.closed, 10) || 0));
    if (!kept && !closed) continue;
    out[name] = { kept, closed };
    if (++n >= 60) break;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PERF_ACTIVITIES, PERF_DEFAULTS, normalizePerformance, normalizeActivityApps, normalizePerfAppChoices };
}
