// The media helper process as the engine holds it, and how its pending requests are failed when
// it is retired.

const { MEDIA_HELPER_BAD_MS } = require('./timings.js');

// ── Persistent SMTC media host ────────────────────────────────────────────────
// media.ps1 used to be spawned one-shot for EVERY media poll (the SSE stream
// broadcasts media every 2s), paying ~150-300ms of CLR + WinRT startup each
// time — the single largest source of steady-state CPU/temp churn, visible to
// users as powershell.exe popping in and out of Task Manager. `media.ps1 -Serve`
// keeps ONE process alive holding the SMTC session manager, answers polls
// in-proc and caches the album-art stream per track. Protocol mirrors the
// sensor worker ("XEMED " + base64 frames), but it gets its OWN process: media
// holds WinRT broker handles, so unlike the sensor worker it is retired
// GRACEFULLY — stdin close lets the serve loop exit and release its handles
// cleanly; a hard kill only fires 3s later if the process refuses to die.
// Any problem falls back to the unchanged one-shot spawn path.
const _mediaHost = {
  proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0, isHelper: false, bornAt: 0, helperBadUntil: 0,
  // Blind-helper detection (issue #80): a helper that answers fine but always
  // reports an empty session list, while the OS actually has one, never trips
  // the death/timeout fallback. These track a run of empties so a persistent
  // one can be cross-checked against the PowerShell host. Reset on each spawn,
  // and again whenever the helper proves it can see a session.
  emptyStreak: 0, crossChecks: 0, lastCrossCheck: 0,
};

function _mediaHostReject(id, err) {
  const p = _mediaHost.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _mediaHost.pending.delete(id);
  p.reject(err);
}

function _retireMediaHost(reason) {
  const proc = _mediaHost.proc;
  _mediaHost.proc = null;
  _mediaHost.buf = '';
  _mediaHost.diedAt = Date.now();
  // A helper exe that dies or misbehaves within seconds of spawning is likely
  // broken (corrupt download, AV block): pin the PS host for a while instead
  // of ping-ponging between the two on every retry window.
  if (_mediaHost.isHelper && reason !== 'shutdown' && Date.now() - _mediaHost.bornAt < 15000) {
    _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
  }
  for (const id of [..._mediaHost.pending.keys()]) _mediaHostReject(id, new Error(reason || 'media host down'));
  if (!proc) return;
  // Closing stdin ends the serve loop → clean process exit → SMTC/WinRT broker
  // handles released the safe way (killing mid-flight is what wedges the broker).
  try { proc.stdin.end(); } catch {}
  const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
  force.unref();
  proc.once('exit', () => clearTimeout(force));
}

module.exports = { _mediaHost, _mediaHostReject, _retireMediaHost };
