// How the update screens read a text in the page's language, and pause the moving background while
// one of them is up.
'use strict';

(() => {
  // Freeze the animated ambient background while this frosted overlay is up (issue
  // #56 — see ambient-freeze.js). Reference-counted by token so it composes with the
  // Settings panel, which is frosted too and can be open underneath us.
  function freezeAmbient(on) {
    try {
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('update', on);
    } catch { /* ignore */ }
  }

  const notice = () => window.XenonReleaseNotice;

  // Text fields may be a plain string or a { <lang>: string } map.
  const pickLang = (v) => notice().localText(v, document.documentElement.lang);

  window.UpdateLook = { freezeAmbient, notice, pickLang };
})();
