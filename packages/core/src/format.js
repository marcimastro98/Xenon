;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.format = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Two-digit zero-pad. `pad2(3) === '03'`.
  function pad2(n) { return String(n).padStart(2, '0'); }

  // Parse a sensor value to a number, tolerating a comma decimal separator
  // ("78,3" → 78.3). Non-numeric → 0. (from widget/modules/state.js toNumber)
  function toNumber(v) {
    if (typeof v === 'number') return v;
    return parseFloat(String(v != null ? v : '').replace(',', '.')) || 0;
  }

  // Clamp a (possibly comma-decimal) value into an integer percent [0, 100].
  // (from widget/modules/state.js clampPercent)
  function clampPercent(v) {
    const n = parseFloat(String(v != null ? v : '').replace(',', '.'));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // Clamp to [min, max]; returns defaultVal when not finite.
  // (from widget/modules/state.js clampRange)
  function clampRange(v, min, max, defaultVal) {
    const n = Number(v);
    if (!Number.isFinite(n)) return defaultVal;
    return Math.max(min, Math.min(max, n));
  }

  // Rich byte formatter used by the dashboard: TB / GB / MB / B.
  // (from server/js/utils.js formatBytes)
  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TB';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
    return b + ' B';
  }

  // Compact byte formatter used by the iCUE widget: GB / MB, '' when falsy.
  // (from widget/modules/state.js formatBytes)
  function formatBytesCompact(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (bytes / (1024 ** 2)).toFixed(0) + ' MB';
  }

  // Seconds → "Hh Mm" (or "Mm" under an hour). (from server/js/utils.js)
  function formatUptime(seconds) {
    const h = Math.floor((seconds || 0) / 3600);
    const m = Math.floor(((seconds || 0) % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Bytes/sec → { value, unit } in bits (Gbps/Mbps/Kbps/bps).
  // (from server/js/utils.js formatBandwidth)
  function formatBandwidth(bps) {
    if (bps == null || !isFinite(bps)) return { value: '--', unit: 'Mbps' };
    const bits = bps * 8;
    if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
    if (bits >= 1e6) return { value: (bits / 1e6).toFixed(1), unit: 'Mbps' };
    if (bits >= 1e3) return { value: (bits / 1e3).toFixed(0), unit: 'Kbps' };
    return { value: String(Math.round(bits)), unit: 'bps' };
  }

  // Date → local "YYYY-MM-DD" (matches server/js/utils.js toDateInputValue and
  // widget/modules/state.js toDateValue).
  function toDateInputValue(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  return {
    pad2, toNumber, clampPercent, clampRange,
    formatBytes, formatBytesCompact, formatUptime, formatBandwidth,
    toDateInputValue,
  };
});
