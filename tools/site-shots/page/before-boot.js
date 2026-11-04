'use strict';
// Runs right before demo/boot.js: the scene's settings become the demo's seed,
// the boot splash and the site's cookie question are skipped, and the demo's
// own bar ("Demo with sample data") is hidden, so the shot shows the app alone.
(function () {
  const shot = window.__SHOT__ || {};
  if (window.__XD__ && shot.settings) Object.assign(window.__XD__.settings, shot.settings);
  try {
    localStorage.setItem('xeneonedge.bootLook.v1', '{"off":true}');
    localStorage.setItem('xenon.site.consent', 'denied');
    localStorage.setItem('uiLang', (shot.settings && shot.settings.language) || 'en');
  } catch { }
  const style = document.createElement('style');
  style.textContent = '#demo-badge,#demo-convert{display:none!important}';
  (document.head || document.documentElement).appendChild(style);
})();
