// What Performance Mode reads from the server and changes nothing with: the open windows, the
// numbers of the machine, what the shield did and the activity in front.
'use strict';

(() => {
  const { classify } = window.PerformanceAppChoice;

  async function fetchWindows() {
    try {
      const res = await fetch(SERVER + '/windows');
      const data = await res.json();
      const list = Array.isArray(data && data.windows) ? data.windows : [];
      return list.filter(w => w && w.id && !w.active && typeof w.app === 'string');
    } catch { return []; }
  }

  // Real measurements: system memory pressure + per-process RAM/CPU, keyed by
  // bare lowercase process name. Null when the probe fails (graceful fallback).
  async function fetchStats() {
    try {
      const res = await fetch(SERVER + '/api/performance/stats');
      const d = await res.json();
      if (!d || !d.ok) return null;
      const byProc = {};
      for (const a of (Array.isArray(d.apps) ? d.apps : [])) {
        byProc[String(a.proc || '').toLowerCase()] = { memMB: Number(a.memMB) || 0, cpuPct: Number(a.cpuPct) || 0 };
      }
      return { byProc, totalMB: Number(d.totalMB) || 0, freeMB: Number(d.freeMB) || 0 };
    } catch { return null; }
  }

  // What Core Shield can do on this PC and what it did this session. It runs on the
  // server, which sees the game and the busy apps. Null when the server did not say.
  async function fetchShield() {
    try {
      const res = await fetch(SERVER + '/api/performance/shield');
      const d = await res.json();
      return d && d.ok ? d : null;
    } catch { return null; }
  }

  async function fetchActivity() {
    try { const res = await fetch(SERVER + '/api/gamemode/status'); const d = await res.json(); return classify(d && d.foreground && d.foreground.process, d && d.activity); }
    catch { return 'other'; }
  }

  window.PerformanceReadings = { fetchWindows, fetchStats, fetchShield, fetchActivity };
})();
