// Paired-device surface (R1.1 / T1) — what the dashboard does differently when
// it is being viewed from a phone instead of from the PC it runs on.
//
// The document already knows: server.js injects `window.__xenonRemote` into the
// served `/` for a request that arrived through the paired-device door, before
// any script runs. This module turns that flag into behaviour.
//
// The design decision worth stating: this file does NOT carry a copy of the
// server's allowlist. Restating "what a phone may not do" on the client is a
// second source of truth that starts correct and drifts the first time someone
// widens the server list and forgets this one — and the failure mode of drift
// is a control that looks alive and silently does nothing. Instead the refusal
// itself is the trigger: a request the paired-device door turns down answers
// `403 {error:'remote_denied'}`, and that answer is explained to the user at
// the exact moment they asked for it. It cannot go stale, because it IS the
// server's answer.
//
// Security lives entirely in server/remote-access.js. Nothing here is a guard —
// hiding a button protects nobody, and no code in this file is trusted.
(function () {
  'use strict';

  const info = (typeof window !== 'undefined' && window.__xenonRemote) || null;
  if (!info) return;                       // running on the PC: nothing to do

  document.documentElement.classList.add('is-remote');

  function label(key, fallback) {
    return (typeof t === 'function' ? t(key) : fallback) || fallback;
  }

  function toast(titleKey, msgKey) {
    if (!window.XenonToast) { console.warn('[remote]', titleKey); return; }
    window.XenonToast.show({ type: 'info', title: label(titleKey, ''), message: label(msgKey, '') });
  }

  // One explanation per refused ENDPOINT, not per tap. A user who keeps pressing
  // a Deck key should be told once, not five times; a user who then tries the
  // disk cleanup is asking a different question and deserves its own answer.
  const explained = new Set();
  function explainDenied(path) {
    if (explained.has(path)) return;
    explained.add(path);
    toast('rs_denied_title', 'rs_denied_msg');
  }

  // Wrap fetch to notice the door's refusals. Deliberately transparent: the
  // response is passed through untouched, so every existing error path still
  // runs exactly as it does on the PC and nothing depends on this wrapper
  // having been installed.
  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      const out = realFetch.apply(this, arguments);
      try {
        return out.then((res) => {
          if (res && res.status === 403) {
            const url = String((input && input.url) || input || '');
            let path = url;
            try { path = new URL(url, location.origin).pathname; } catch { /* keep the raw string */ }
            // Read a CLONE: consuming the body here would leave the caller with
            // an already-read stream, which is how a diagnostic becomes a bug.
            res.clone().json()
              .then((body) => { if (body && body.error === 'remote_denied') explainDenied(path); })
              .catch(() => { /* not our JSON refusal — leave it to the caller */ });
          }
          return res;
        });
      } catch { return out; }
    };
  }

  // Said once per page load, on arrival: which device this is, and the one
  // thing about it that differs from the dashboard on the PC.
  function greet() {
    toast('rs_welcome_title', 'rs_welcome_msg');
  }
  if (document.readyState === 'complete') setTimeout(greet, 1500);
  else window.addEventListener('load', () => setTimeout(greet, 1500), { once: true });

  window.RemoteSurface = {
    isRemote: () => true,
    deviceName: () => String(info.device || ''),
    /**
     * The same explanation, for a caller the fetch wrapper cannot see.
     * XMLHttpRequest is the only one today — the file upload uses it because
     * fetch() has no upload-progress event — and without this its 403 would be
     * the one refusal on this surface that goes unexplained. Exported rather
     * than reimplemented so there is still exactly one copy of the message and
     * one once-per-endpoint rule.
     */
    explainDenied,
  };
})();
