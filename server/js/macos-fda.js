'use strict';

// ── macOS: Xenon lost Full Disk Access ──────────────────────────────────────
// One notice, once per dashboard load, when macOS has taken the permission
// away — which it does BY ITSELF. The grant is bound to the app's code
// signature, Xenon's is ad-hoc (no paid Apple certificate), and an ad-hoc
// signature's hash changes with every build. So every Xenon update silently
// revokes Full Disk Access, and the user is never told.
//
// What that looked like before this existed: search stopped finding anything
// and the Disk widget's map went empty, both without a word — and because the
// index then tried to walk the home folder anyway, macOS asked permission for
// the Desktop, then Documents, then Downloads, then Photos, then Music, on
// every pass. Measured on macOS 26: five dialogs before the dashboard had
// finished starting, again a minute later, for two hours.
//
// The server now withholds the home root while the grant is missing, so the
// dialogs are gone — which means without this notice the only remaining symptom
// would be silence. Hence a sticky toast that says what happened and opens the
// right pane, rather than a line buried in Settings.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : fb);
  let notified = false;

  function openSettingsPane() {
    // Fixed path, no input: the server refuses it off macOS and builds the URL
    // itself (nothing from here reaches a command line).
    fetch('/macos/fda-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => { /* the toast stays; the user can open it by hand */ });
  }

  async function check() {
    if (notified) return true;
    let st = null;
    try {
      st = await (await fetch('/index/status', { cache: 'no-store' })).json();
    } catch {
      return false;
    }
    // The server sets this flag ONLY on macOS and ONLY when it actually
    // withheld a root, so there is no platform test to get wrong on this side.
    if (!st || !st.fdaBlocked) return false;
    notified = true;
    if (!window.XenonToast) return true;
    window.XenonToast.show({
      type: 'warning',
      kicker: 'macOS',
      // Short on purpose: the title is one line with an ellipsis and the
      // message is clamped to two, so anything longer is cut mid-sentence. The
      // full explanation lives in the Disk widget card and in Settings.
      title: t('fda_toast_title', 'Xenon ha perso un permesso'),
      message: t('fda_toast_msg', 'L’aggiornamento gli ha tolto l’Accesso completo al disco: ricerca e mappa del disco restano vuote.'),
      duration: 0,   // sticky: it is actionable and it does not fix itself
      actions: [{
        label: t('fda_toast_open', 'Apri le impostazioni'),
        primary: true,
        onClick: openSettingsPane,
      }],
    });
    return true;
  }

  // Two attempts, then stop. The first is late enough not to compete with boot;
  // the second covers the case where the page loaded before the server had
  // finished asking macOS (it probes a few seconds after it starts listening,
  // then once a minute). A permission granted later needs no further polling
  // here — the server picks it up within a minute and the widgets refill on
  // their own.
  function schedule() {
    setTimeout(() => {
      check().then((done) => {
        if (done) return;
        setTimeout(() => { check(); }, 75000);
      });
    }, 12000);
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();
