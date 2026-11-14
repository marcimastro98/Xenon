'use strict';
// Remembers each symbol's last move so a price alert is announced once.

function createAlertTracker() {
  let state = new Map(); // symbol → { up: bool, down: bool, day }
  return {
    evaluate(quotes, alertPercent, dayKey) {
      const alerts = [];
      const threshold = Math.abs(Number(alertPercent) || 0);
      if (!threshold) return alerts;
      for (const q of (quotes || [])) {
        const pct = Number(q.changePct);
        if (!Number.isFinite(pct)) continue;
        // Latch EACH direction independently, once per day — so an intraday
        // oscillation (+2% → -2% → +2%) fires up once and down once, never the
        // same direction twice. A new day resets both latches.
        let s = state.get(q.symbol);
        if (!s || s.day !== dayKey) { s = { up: false, down: false, day: dayKey }; state.set(q.symbol, s); }
        const push = (dir) => alerts.push({ symbol: q.symbol, name: q.name, dir, changePct: pct, price: q.price, currency: q.currency });
        if (pct >= threshold && !s.up) { s.up = true; push('up'); }
        else if (pct <= -threshold && !s.down) { s.down = true; push('down'); }
      }
      return alerts;
    },
    reset() { state = new Map(); },
  };
}

module.exports = { createAlertTracker };
