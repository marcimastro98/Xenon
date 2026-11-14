// What a failed update says: the words for the step that failed, the line that tells whether the
// old version came back, and the tool's own sentence next to it.
'use strict';

(() => {
  function tr(key, fallback) {
    return (typeof window.t === 'function' && window.t(key)) || fallback;
  }

  // Human text for an applier reason code (npm_install_failed, verify_failed…).
  // Unknown codes fall through verbatim so they stay diagnosable from a screenshot.
  function updReasonText(code) {
    if (!code) return '';
    const key = 'update_reason_' + code;
    const v = (typeof window.t === 'function') ? window.t(key) : '';
    return (v && v !== key) ? v : code;
  }

  // One-line explanation of a failed apply from the applier's persisted result.
  //
  // `detail` is the failing tool's OWN sentence, when there is one — today that
  // means npm's first `npm ERR!` line, captured by update-apply.ps1. The reason
  // code names the stage that failed and stops there, which is a true answer to a
  // question nobody is asking: "dependency installation failed" is the same text
  // whether the machine is offline, behind a proxy, out of disk, or has an
  // antivirus holding a file open, and those have four different fixes. It is
  // shown verbatim and untranslated on purpose: it is a tool's own words, and it
  // exists to be read and pasted by whoever is stuck.
  function applyFailureText(lastResult) {
    const base = lastResult && lastResult.rolledBack === false
      ? tr('update_failed_not_rolled_back', 'The update failed and automatic recovery also failed: please re-run INSTALL.bat.')
      : tr('update_failed_rolled_back', 'The update could not be applied and your previous version was restored.');
    const reason = updReasonText(lastResult && lastResult.reason);
    const detail = String((lastResult && lastResult.detail) || '').trim().slice(0, 200);
    return base + (reason ? ' (' + reason + ')' : '') + (detail ? ' — ' + detail : '');
  }

  const trKey = (key) => tr(key, key);

  function failureReason(lr) {
    const detail = String(lr.detail || '').trim().slice(0, 200);
    return [updReasonText(lr.reason), detail].filter(Boolean).join(': ') || applyFailureText(lr);
  }

  window.UpdateFailureWords = { tr, applyFailureText, trKey, failureReason };
})();
