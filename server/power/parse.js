'use strict';
// Pure readers for the PC's own battery and the system power mode, one per OS
// source. Each returns the shapes power/index.js hands out:
//   battery  { percent, plugged, charging, minutesLeft } or null (no battery)
//   mode     'saver' | 'balanced' | 'performance' | null (cannot be read)
// Unit-tested without a laptop underneath (test/power.test.mjs).

const MODES = Object.freeze(['saver', 'balanced', 'performance']);

// Windows 11 "Power mode" (Settings, Power): an overlay on the Balanced plan.
// The three GUIDs are the ones Windows ships; an OEM can add its own.
const WIN_OVERLAY = Object.freeze({
  saver: '961cc777-2547-4f9d-8174-7d86181b8a7a',
  balanced: '00000000-0000-0000-0000-000000000000',
  performance: 'ded574b5-45a0-4f42-8737-46345c09c238',
});
// Windows 10's "Better performance" slider step reads as balanced.
const WIN_OVERLAY_ALSO_BALANCED = '3af9b8d9-7c97-431d-ad78-34a8bfea439f';
const WIN_BALANCED_PLAN = '381b4222-f694-41f0-9685-ff5bb260df2e';
const WIN_UNKNOWN = 0xFFFFFFFF;

function clampPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

function minutes(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100 * 60 ? Math.round(n) : null;
}

// GetSystemPowerStatus (SYSTEM_POWER_STATUS). BatteryFlag 128 = no system
// battery, 255 = unknown; bit 8 = charging. SystemStatusFlag 1 = Energy saver on.
function windowsStatus(s) {
  const st = s && typeof s === 'object' ? s : {};
  const saver = st.sys === 1;
  if (st.flag === 128 || st.flag === 255) return { battery: null, saver };
  const percent = clampPercent(st.pct === 255 ? null : st.pct);
  if (percent == null) return { battery: null, saver };
  const plugged = st.ac === 1;
  return {
    battery: {
      percent,
      plugged,
      charging: (st.flag & 8) === 8,
      minutesLeft: plugged || st.life === WIN_UNKNOWN ? null : minutes(st.life / 60),
    },
    saver,
  };
}

// The mode is the overlay, but only the Balanced plan has one: on High
// performance or a custom plan Windows greys the setting out, and so does Xenon.
function windowsMode(planGuid, overlayGuid) {
  const plan = String(planGuid || '').toLowerCase();
  if (plan !== WIN_BALANCED_PLAN) return { mode: null, why: 'plan' };
  const overlay = String(overlayGuid || '').toLowerCase();
  if (overlay === WIN_OVERLAY_ALSO_BALANCED) return { mode: 'balanced' };
  const mode = MODES.find((m) => WIN_OVERLAY[m] === overlay);
  return mode ? { mode } : { mode: null, why: 'custom' };
}

// `pmset -g batt`:
//   Now drawing from 'Battery Power'
//    -InternalBattery-0 (id=4653155)	82%; discharging; 4:12 remaining present: true
function pmsetBattery(text) {
  const lines = String(text || '').split('\n');
  const line = lines.find((l) => /InternalBattery/.test(l));
  if (!line) return null;
  const pct = /(\d{1,3})%/.exec(line);
  const percent = clampPercent(pct && pct[1]);
  if (percent == null) return null;
  const plugged = /'AC Power'/.test(lines[0] || '') || /AC attached/.test(line);
  const left = /(\d+):(\d{2}) remaining/.exec(line);
  return {
    percent,
    plugged,
    charging: /;\s*charging;/.test(line) || /finishing charge/.test(line),
    minutesLeft: !plugged && left ? minutes(Number(left[1]) * 60 + Number(left[2])) : null,
  };
}

// `pmset -g`: " lowpowermode 1", and on newer Macs " powermode 0|1|2"
// (automatic, low power, high power).
function pmsetMode(text) {
  const s = String(text || '');
  const pm = /^\s*powermode\s+(\d)/m.exec(s);
  if (pm) return pm[1] === '1' ? 'saver' : pm[1] === '2' ? 'performance' : 'balanced';
  const low = /^\s*lowpowermode\s+(\d)/m.exec(s);
  if (low) return low[1] === '1' ? 'saver' : 'balanced';
  return null;
}

// /sys/class/power_supply/<name>/*, one object per supply. A "Device" scope is
// a mouse or a headset, not the PC.
function sysfsBattery(supplies) {
  const list = Array.isArray(supplies) ? supplies : [];
  const packs = list.filter((p) => p && p.type === 'Battery' && p.scope !== 'Device' && clampPercent(p.capacity) != null);
  if (!packs.length) return null;
  const mains = list.some((p) => p && p.type === 'Mains' && String(p.online).trim() === '1');
  const status = packs.map((p) => String(p.status || '').trim());
  const charging = status.includes('Charging');
  const plugged = mains || charging || status.every((s) => s === 'Full' || s === 'Not charging');
  const percent = Math.round(packs.reduce((a, p) => a + clampPercent(p.capacity), 0) / packs.length);
  let left = null;
  if (!plugged) {
    const sum = (k) => packs.reduce((a, p) => a + (Number(p[k]) > 0 ? Number(p[k]) : 0), 0);
    const draw = sum('power_now') || sum('current_now');
    const store = sum('power_now') ? sum('energy_now') : sum('charge_now');
    if (draw > 0 && store > 0) left = minutes((store / draw) * 60);
  }
  return { percent, plugged, charging, minutesLeft: left };
}

const PPD_TO_MODE = Object.freeze({ 'power-saver': 'saver', balanced: 'balanced', performance: 'performance' });
const MODE_TO_PPD = Object.freeze({ saver: 'power-saver', balanced: 'balanced', performance: 'performance' });

// `powerprofilesctl list`:
//   * balanced:
//       PlatformDriver: amd_pmf
//     power-saver:
//       ...
function ppdList(text) {
  const modes = [];
  let mode = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^(\*?)\s*(power-saver|balanced|performance):\s*$/.exec(line);
    if (!m) continue;
    modes.push(PPD_TO_MODE[m[2]]);
    if (m[1] === '*') mode = PPD_TO_MODE[m[2]];
  }
  return { mode, modes: MODES.filter((m) => modes.includes(m)) };
}

module.exports = {
  MODES, WIN_OVERLAY, WIN_BALANCED_PLAN, MODE_TO_PPD,
  windowsStatus, windowsMode, pmsetBattery, pmsetMode, sysfsBattery, ppdList,
};
