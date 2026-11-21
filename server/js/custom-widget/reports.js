// What the probe inside a widget reported about it: how heavy it runs, what the sandbox refused,
// what went wrong and what its tile cuts off, kept per package for its author to read.
'use strict';

(() => {
  // Reports come from the host-injected probe, but the frame could forge them:
  // SdkPerf.validatePerfReport clamps every field and the per-frame rate limit
  // bounds the flood. Aggregated per PACKAGE (a service frame and a tile of the
  // same package fold together — it's the package's CPU either way).
  const perfByPkg = new Map();   // pkgId → SdkPerf aggregate

  // For the widget's AUTHOR: the Installed tab lists these under their own
  // packages, so a blank tile says why. Same trust as perf: the frame could
  // forge a report, so SdkDiagnostics validates it to known kinds + a bare
  // hostname, a per-frame floor bounds the flood, and nothing is granted.
  const BLOCKED_MIN_INTERVAL_MS = 1000;
  const blockedByPkg = new Map();   // pkgId → [{ kind, host? }]

  function onBridgeBlocked(entry, msg) {
    if (!window.SdkDiagnostics) return;
    const now = Date.now();
    if (now - (entry.blockedAt || 0) < BLOCKED_MIN_INTERVAL_MS) return;
    entry.blockedAt = now;
    const issues = SdkDiagnostics.validateBlockedReport(msg);
    if (!issues || !issues.length) return;
    blockedByPkg.set(entry.pkgId, SdkDiagnostics.mergeIssues(blockedByPkg.get(entry.pkgId), issues));
  }

  function getSandboxIssues(pkgId) {
    return (blockedByPkg.get(pkgId) || []).slice();
  }

  // Same trust and the same floor as the blocked list: the author reads these
  // through the xenon-mcp tools. Text only, never rendered as HTML.
  const errorsByPkg = new Map();   // pkgId → [{ kind, message, count }]

  function onBridgeError(entry, msg) {
    if (!window.SdkDiagnostics || typeof SdkDiagnostics.validateErrorReport !== 'function') return;
    const now = Date.now();
    if (now - (entry.errorAt || 0) < BLOCKED_MIN_INTERVAL_MS) return;
    entry.errorAt = now;
    const items = SdkDiagnostics.validateErrorReport(msg);
    if (!items || !items.length) return;
    errorsByPkg.set(entry.pkgId, SdkDiagnostics.mergeErrors(errorsByPkg.get(entry.pkgId), items));
  }

  function getRuntimeErrors(pkgId) {
    return (errorsByPkg.get(pkgId) || []).map((e) => ({ ...e }));
  }

  // What the tile cuts off of a widget, as its probe measured it last (any frame of the package:
  // the newest look wins). Same trust and floor as above. whenFit is one wait for the NEXT look,
  // the one after a change: Bit asks it about a widget it just made or edited.
  const fitByPkg = new Map();      // pkgId → { w, h, items }
  const fitWaits = new Map();      // pkgId → { fn, until }

  function onFitReport(entry, msg) {
    if (!window.SdkDiagnostics || typeof SdkDiagnostics.validateFitReport !== 'function') return;
    const now = Date.now();
    if (now - (entry.fitAt || 0) < BLOCKED_MIN_INTERVAL_MS) return;
    const fit = SdkDiagnostics.validateFitReport(msg);
    if (!fit) return;
    entry.fitAt = now;
    fitByPkg.set(entry.pkgId, fit);
    const wait = fitWaits.get(entry.pkgId);
    fitWaits.delete(entry.pkgId);
    if (wait && now <= wait.until) wait.fn(getFit(entry.pkgId));
  }

  function getFit(pkgId) {
    const fit = fitByPkg.get(pkgId);
    return fit ? { w: fit.w, h: fit.h, items: fit.items.map((i) => ({ ...i })) } : null;
  }

  function whenFit(pkgId, fn, withinMs) {
    fitWaits.set(pkgId, { fn, until: Date.now() + withinMs });
  }

  // New files on disk (install, Rescan, the tile's Reload): what the old code reported or how it
  // was laid out is no longer true. A wait Bit armed stays, it is for the new code's first look.
  function forgetRuns() {
    blockedByPkg.clear();
    errorsByPkg.clear();
    fitByPkg.clear();
  }

  // Plain serializable snapshot for the Installed tab's activity chips.
  function getPerfStats() {
    const out = {};
    if (!window.SdkPerf) return out;
    perfByPkg.forEach((agg, pkgId) => {
      out[pkgId] = {
        level: SdkPerf.classifyPerf(agg),
        longTaskMsPerMin: SdkPerf.longTaskMsPerMin(agg),
        layoutShifts: agg.layoutShifts,
        updatedAt: agg.updatedAt,
      };
    });
    return out;
  }

  window.CustomWidgetReports = {
    perfByPkg, onBridgeBlocked, getSandboxIssues, onBridgeError, getRuntimeErrors, getPerfStats,
    onFitReport, getFit, whenFit, forgetRuns,
  };
})();
