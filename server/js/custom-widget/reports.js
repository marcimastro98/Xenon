// What the probe inside a widget reported about it: how heavy it runs, what the sandbox refused and
// what went wrong, kept per package for its author to read.
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
    perfByPkg, blockedByPkg, onBridgeBlocked, getSandboxIssues, errorsByPkg, onBridgeError,
    getRuntimeErrors, getPerfStats,
  };
})();
