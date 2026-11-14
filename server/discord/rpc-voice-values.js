'use strict';
// The small sums behind the Discord voice controls: a switch flipped, push-to-talk toggled, a
// volume nudged, and one person's volume.

// Per-user LOCAL playback volume (SET_USER_VOICE_SETTINGS): Discord's own
// per-user slider spans 0-200% and sits at 100 by default.
const USER_VOL_MAX = 200;
const DEFAULT_USER_VOL = 100;

// The next self-mute/deaf boolean for a mode against the current state.
function toggleValue(mode, current, onWord, offWord) {
  if (mode === onWord) return true;
  if (mode === offWord) return false;
  return !current;               // 'toggle'
}

// The next voice mode type ('PUSH_TO_TALK' | 'VOICE_ACTIVITY'). 'vad' = voice
// activity detection.
function nextPttType(mode, currentType) {
  if (mode === 'ptt') return 'PUSH_TO_TALK';
  if (mode === 'vad') return 'VOICE_ACTIVITY';
  return currentType === 'PUSH_TO_TALK' ? 'VOICE_ACTIVITY' : 'PUSH_TO_TALK';   // 'toggle'
}

// Nudge a voice volume by ±10 within Discord's range (input 0-100, output 0-200).
function nudgedVolume(current, dir, max) {
  const now = Number.isFinite(current) ? current : 0;
  const next = now + (dir === 'down' ? -10 : 10);
  return Math.max(0, Math.min(max, Math.round(next)));
}

// Parse an absolute per-user volume percentage. Discord's own per-user slider
// spans 0-200, so unlike setVolumeAbs (which caps the MASTER output at 100 by
// choice) this keeps the full native range: a widget replacing that slider has
// to be able to reach the same values. Empty/whitespace rejects loud —
// Number('') is 0 and would silence the person instead of failing.
function userVolumeAbs(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const pct = Number(raw.replace(',', '.'));
  if (!Number.isFinite(pct)) return null;
  return Math.min(USER_VOL_MAX, Math.max(0, Math.round(pct)));
}

// The next per-user volume for a mode against the member's current one.
// `current` is what Discord reports for that member (null = unreported, treated
// as the 100 default). Returns null when a 'set' carries no usable value.
function userVolumeFor(mode, current, value) {
  const now = Number.isFinite(current) ? current : DEFAULT_USER_VOL;
  if (mode === 'set') return userVolumeAbs(value);
  return nudgedVolume(now, mode, USER_VOL_MAX);
}

module.exports = {
  USER_VOL_MAX, DEFAULT_USER_VOL, toggleValue, nextPttType, nudgedVolume, userVolumeAbs,
  userVolumeFor,
};
