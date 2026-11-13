// Notices a helper program that keeps reporting nothing playing while Windows has a player
// open, and hands the media reading back to the script.

const { readFailed } = require('../media-read.js');
const {
  MEDIA_HELPER_BAD_MS, MEDIA_BLIND_STREAK, MEDIA_CROSSCHECK_BASE_MS, MEDIA_CROSSCHECK_MAX_MS,
} = require('./timings.js');
const { MEDIA_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { _mediaHost, _retireMediaHost } = require('./host-state.js');
const { mediaChoice } = require('./preferred-source.js');
const { backgroundHeld } = require('../performance/background-held.js');

// A helper that answers fine but reports an empty session list on EVERY poll —
// while the OS actually has an active SMTC session — leaves the Media panel
// blank with no error, so the death/timeout fallback never trips (issue #80:
// a broken / AV-mangled helper on some machines; the user's own fix was to
// hard-disable the helper). Cross-check a persistent empty against the
// PowerShell host: if PS sees a session the helper is blind on this machine, so
// pin the helper out and hand back what PS found. Heavily gated so an idle
// machine pays almost nothing — only the helper, only after a streak of
// empties, at most once a minute, only until the helper first proves it can see
// a session, and only a few times per host lifetime.
async function _guardHelperMediaBlindSpot(out) {
  // The read failed: the helper is not blind, and PowerShell would hang on the same service.
  if (readFailed(out)) return out;
  const empty = !out || (out.active === false && (!Array.isArray(out.sessions) || out.sessions.length === 0));
  // A session (playing OR paused) proves the helper can see SMTC on this machine
  // and reopens the detection budget: if it later goes blind mid-session (broker
  // wedge), the next run of empties is cross-checked again rather than trusted.
  if (!empty) { _mediaHost.emptyStreak = 0; _mediaHost.crossChecks = 0; return out; }
  if (++_mediaHost.emptyStreak < MEDIA_BLIND_STREAK) return out;
  // Each look is a whole PowerShell, and a blind helper can wait for the end of a game.
  if (backgroundHeld()) return out;
  // Rate-limit the PS cross-check with an escalating interval instead of a hard
  // lifetime cap. A hard cap (the old MEDIA_CROSSCHECK_MAX) was exhausted by the
  // agreed-empty cross-checks a machine racks up while merely idle at startup, so
  // a helper that only goes blind AFTER playback finally starts was never
  // cross-checked again and the Media panel stayed stuck on "Nothing playing" for
  // the rest of the host's lifetime. Backing off (1 min → capped at 5 min) keeps a
  // truly idle machine cheap while still catching a blind helper within one
  // interval once music actually plays; the moment the helper sees any session the
  // `!empty` branch above resets the interval to the 1-minute floor.
  const interval = Math.min(MEDIA_CROSSCHECK_BASE_MS * (2 ** _mediaHost.crossChecks), MEDIA_CROSSCHECK_MAX_MS);
  if (Date.now() - _mediaHost.lastCrossCheck < interval) return out;
  _mediaHost.lastCrossCheck = Date.now();
  let ps;
  // Count a failed cross-check against the budget too, so an unusable PS reader
  // can't make us spawn one every minute forever.
  try { ps = await runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs('info'), 8000); }
  catch { _mediaHost.crossChecks++; return out; }
  // The helper reported ZERO sessions; the blindness signal is simply that PS can
  // see a session the helper can't — in ANY playback state. Comparing the raw
  // session list (not ps.active) is what catches a PAUSED track: media.ps1 only
  // sets active:true while Playing, so the old ps.active check treated a blind
  // helper next to a paused-but-visible session as "agreed empty" and never
  // retired it. Both empty → genuinely nothing playing.
  const psSaw = ps && Array.isArray(ps.sessions) && ps.sessions.length > 0;
  if (!psSaw) { _mediaHost.crossChecks++; return out; }     // both agree: nothing is playing
  _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
  _retireMediaHost('helper media blind');                   // drop to the PS host for a while
  return ps;
}

function mediaScriptArgs(action, position) {
  const args = [action];
  if (mediaChoice.source || action === 'seek') args.push(mediaChoice.source || '');
  if (action === 'seek') args.push(String(position));
  return args;
}

module.exports = { _guardHelperMediaBlindSpot, mediaScriptArgs };
