// Cleans the saved notification settings: reminders, health nudges, Discord, Windows notifications,
// calls and the paired phone.
'use strict';

// Mirror of normalizeSnowflakeList in server.js — keep in step. Bounded and
// deduped: this list is used as a DOM key in the Discord widget, and the server
// rebuilds the blob from whatever the browser sends.
function normalizeSnowflakeList(value, max = 50) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const id = String(raw == null ? '' : raw).trim();
    if (!/^\d{5,25}$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

// Master notifications switch (Settings → Notifiche). Both default ON; same shape
// the server persists so both sides normalize identically.
function normalizeNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  // Do-not-disturb mode, mirrored from the server normalizer (server.js).
  // 'auto' (default) holds routine pop-ups back while the screen is immersive,
  // 'always' holds them back the whole time, 'off' never does. Enforced in
  // js/toast.js, which never holds back an error, warning, reminder or timer.
  const quiet = (v.quiet === 'off' || v.quiet === 'always') ? v.quiet : 'auto';
  // `onScreen`: in "Solo widget" (no dashboard window) the same pop-ups show in
  // a small click-through window on the main screen (/screen-alerts).
  return { enabled: v.enabled !== false, popups: v.popups !== false, sounds: v.sounds !== false, quiet, onScreen: v.onScreen !== false };
}

// Vitals — known-key rebuild, identical to the server normalizer (server.js):
// per-vital enable + interval, plus the widget-owned state (last-refill
// timestamps, XP, daily fill counter).
function vitalsHour(h) { return Number.isInteger(h) && h >= 0 && h <= 23; }
function normalizeVitals(value) {
  const v = value && typeof value === 'object' ? value : {};
  const itemsSrc = v.items && typeof v.items === 'object' ? v.items : {};
  const stateSrc = v.state && typeof v.state === 'object' ? v.state : {};
  const lastSrc = stateSrc.last && typeof stateSrc.last === 'object' ? stateSrc.last : {};
  const items = {};
  const last = {};
  VITALS_IDS.forEach((id) => {
    const it = itemsSrc[id] && typeof itemsSrc[id] === 'object' ? itemsSrc[id] : {};
    items[id] = {
      on: typeof it.on === 'boolean' ? it.on : VITALS_DEFAULT_ON[id],
      min: Math.round(clampNumber(it.min, 5, 480, VITALS_DEFAULT_MIN[id])),
    };
    const ts = Number(lastSrc[id]);
    last[id] = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  });
  // Bit, the pixel guardian pet. Each rung of the nag ladder is strict opt-in:
  // the PC-invading actions (monitor popups, minimize-all, workstation lock)
  // require `=== true`, so nothing invasive can turn itself on via a stale blob.
  const petSrc = v.pet && typeof v.pet === 'object' ? v.pet : {};
  const thrSrc = petSrc.thresholds && typeof petSrc.thresholds === 'object' ? petSrc.thresholds : {};
  const thresholds = {};
  VITALS_PET_STAGES.forEach((stage) => {
    thresholds[stage] = Math.round(clampNumber(thrSrc[stage], 1, 480, VITALS_PET_DEFAULT_THR[stage]));
  });
  const pet = {
    enabled: petSrc.enabled === true,
    tone: ['soft', 'spicy', 'savage'].includes(petSrc.tone) ? petSrc.tone : 'spicy',
    effects: petSrc.effects !== false,
    sounds: petSrc.sounds !== false,
    lighting: petSrc.lighting === true,
    monitors: petSrc.monitors === true,
    minimize: petSrc.minimize === true,
    lock: petSrc.lock === true,
    quietInGame: petSrc.quietInGame !== false,
    // Where Bit lives: the floating corner sprite, a mini chip in the topbar
    // clock cluster, or both. AI roasts (Xenon AI-generated lines with offline
    // bank fallback) are strict opt-in; night quiet (23–07: Bit sleeps, never
    // escalates past decay) is on by default.
    position: ['floating', 'topbar', 'both'].includes(petSrc.position) ? petSrc.position : 'floating',
    aiRoasts: petSrc.aiRoasts === true,
    // With Sparks as the AI, the Sparks a day the roasts may spend (0 = never).
    roastSparksCap: VITALS_ROAST_SPARKS_CAPS.includes(Number(petSrc.roastSparksCap)) ? Number(petSrc.roastSparksCap) : 0,
    nightQuiet: petSrc.nightQuiet !== false,
    // The quiet window, whole local hours: from (inclusive) to (exclusive),
    // wrapping past midnight when from > to; from === to means no quiet hours.
    // Anything but an hour 0-23 reads as the default (null is not midnight).
    quietFrom: vitalsHour(petSrc.quietFrom) ? petSrc.quietFrom : 23,
    quietTo: vitalsHour(petSrc.quietTo) ? petSrc.quietTo : 7,
    thresholds,
  };
  // Bit's durable bookkeeping (state.pet): truce (snooze/mute-today) and the
  // per-episode escalation flags, persisted so a reload can't re-fire GAME
  // OVER/minimize/lock and a truce granted on one surface holds on the others.
  // Episodes are keyed by z = the episode's zeroAt instant (a stable identity
  // across reloads and surfaces). Known-key rebuild — never spread.
  const petStSrc = stateSrc.pet && typeof stateSrc.pet === 'object' ? stateSrc.pet : {};
  const epSrc = petStSrc.ep && typeof petStSrc.ep === 'object' ? petStSrc.ep : {};
  const ep = {};
  VITALS_IDS.forEach((id) => {
    const e = epSrc[id];
    if (!e || typeof e !== 'object') return;
    const z = Number(e.z);
    if (!Number.isFinite(z) || z <= 0) return;
    ep[id] = {
      z: Math.floor(z),
      goAt: Math.max(0, Math.floor(Number(e.goAt) || 0)),
      ovAt: Math.max(0, Math.floor(Number(e.ovAt) || 0)),
      min: e.min === true,
      lock: e.lock === true,
    };
  });
  const statePet = {
    snoozeUntil: Math.round(clampNumber(petStSrc.snoozeUntil, 0, Date.now() + 24 * 3600000, 0)),
    muteDay: typeof petStSrc.muteDay === 'string' ? petStSrc.muteDay.slice(0, 10) : '',
    ep,
  };
  // Bit's long-term memory: daily self-care streak + grow-only lifetime
  // counters (fuel for contextual/AI roasts and streak praise).
  const memSrc = stateSrc.mem && typeof stateSrc.mem === 'object' ? stateSrc.mem : {};
  const mem = {
    streak: Math.round(clampNumber(memSrc.streak, 0, 100000, 0)),
    bestStreak: Math.round(clampNumber(memSrc.bestStreak, 0, 100000, 0)),
    lastFillDay: typeof memSrc.lastFillDay === 'string' ? memSrc.lastFillDay.slice(0, 10) : '',
    locksTotal: Math.round(clampNumber(memSrc.locksTotal, 0, 1e6, 0)),
    gameoversTotal: Math.round(clampNumber(memSrc.gameoversTotal, 0, 1e6, 0)),
  };
  return {
    enabled: v.enabled !== false,
    topbar: v.topbar === true,
    reminders: v.reminders !== false,
    // Freeze the meters while the user is away from the PC (no real input for
    // 5+ min, via the server idle probe) and resume exactly where they were.
    awayPause: v.awayPause !== false,
    naturalBreaks: v.naturalBreaks !== false,
    pet,
    items,
    state: {
      last,
      xp: Math.round(clampNumber(stateSrc.xp, 0, 1e9, 0)),
      day: typeof stateSrc.day === 'string' ? stateSrc.day.slice(0, 10) : '',
      fills: Math.round(clampNumber(stateSrc.fills, 0, 100000, 0)),
      // Today's refills in order (the widget's "combo ribbon"); bounded.
      log: Array.isArray(stateSrc.log) ? stateSrc.log.filter(x => VITALS_IDS.includes(x)).slice(-40) : [],
      // freezeStart identity of the last credited away period (see
      // vitals-pet-core.awayCredit) — merged as max server-side.
      awayCreditAt: Math.max(0, Math.floor(Number(stateSrc.awayCreditAt) || 0)),
      pet: statePet,
      mem,
    },
  };
}

// Discord notification mirroring — privacy-touching, strict opt-in: anything
// that isn't literally `true` stays off.
function normalizeDiscordNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, hide: v.hide === true };
}

// Windows notification mirroring — same shape the server persists (known-key
// rebuild, bounded excluded list) so both sides normalize identically.
function normalizeWindowsNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  const excluded = [];
  if (Array.isArray(v.excluded)) {
    for (const e of v.excluded.slice(0, 100)) {
      const id = String((e && e.id) || '').slice(0, 200).trim();
      if (!id) continue;
      excluded.push({ id, name: String((e && e.name) || '').slice(0, 200) });
    }
  }
  // `toast` defaults ON: when the feature is enabled, a new toast pops for each
  // incoming notification unless the user turns pop-ups off (purely presentational
  // — the reader runs regardless, so this doesn't change background cost).
  return { enabled: v.enabled === true, hide: v.hide === true, toast: v.toast !== false, excluded };
}

// Incoming calls — mirrors normalizeCalls in server.js, key for key. Both sides
// persist this, so both sides rebuild it from known keys with the same defaults;
// a key only one side models is a key that gets wiped on the next save.
function normalizeCallsClient(value) {
  const v = value && typeof value === 'object' ? value : {};
  const disabledApps = [];
  if (Array.isArray(v.disabledApps)) {
    for (const id of v.disabledApps.slice(0, 40)) {
      const s = String(id || '').trim().slice(0, 40);
      if (s && !disabledApps.includes(s)) disabledApps.push(s);
    }
  }
  const apps = [];
  if (Array.isArray(v.apps)) {
    for (const raw of v.apps.slice(0, 20)) {
      const a = raw && typeof raw === 'object' ? raw : {};
      const id = String(a.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      if (!id) continue;
      const match = [];
      if (Array.isArray(a.match)) {
        for (const m of a.match.slice(0, 10)) {
          const s = String(m || '').trim().slice(0, 80);
          if (s) match.push(s);
        }
      }
      if (!match.length) continue;
      if (apps.some(e => e.id === id)) continue;
      apps.push({ id, name: String(a.name || id).slice(0, 60), match });
    }
  }
  return { enabled: v.enabled === true, push: v.push !== false, sound: v.sound !== false, disabledApps, apps };
}

// The paired phone — mirrors normalizePhone in server.js, key for key, for the
// reason spelled out above normalizeCallsClient: POST /settings rebuilds the
// whole blob from what the browser sent, so a key modelled on only one side is
// a key that switches itself off the next time the user changes anything else.
function normalizePhoneClient(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, ring: v.ring !== false, hide: v.hide !== false };
}
