// The hints Xenon gives once each (js/xenon-hints.js), as the dashboard draws them:
// the first paired phone, the key after the first game, where the dashboard went in
// "widgets only" (drawn here by the same toast the alerts window uses), and the About
// row that brings them back. tools/app-shots/scenes.mjs spreads these in. Run inside
// the page, so each takes what it needs as the scene's `arg`, never from a closure.
/* global setLang, openSettings */

const ROUTES = { '/hints': { ok: true, seen: [] }, '/xenon-menu': { menuKey: 'Alt+Shift+X' } };

async function hint({ lang = 'it', which = 'phone' } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(400);
  const state = () => ({ widgetsOnly: true, gaming: false });
  if (which === 'phone') await window.XenonHints.paired({ name: 'Pixel 9' });
  if (which === 'game') window.XenonHints.screen({ first: false, gameEnded: true, state });
  if (which === 'dashboard') {
    // The hint waits minutes after the window starts: here it comes at once.
    const later = window.setTimeout;
    window.setTimeout = (fn) => later(fn, 0);
    window.XenonHints.screen({ first: true, gameEnded: false, state });
    window.setTimeout = later;
  }
  if (which === 'about') {
    openSettings('about');
    await pause(1200);
    document.querySelector('.settings-hints-group')?.scrollIntoView({ block: 'center' });
  }
  await pause(1500);
  return which === 'about' ? null : '.xtoast';
}

const scene = (lang, which, sizes) => ({ routes: ROUTES, sizes, open: hint, arg: { lang, which } });

export const hintsScenes = {
  'hint-phone': scene('it', 'phone', ['desk', 'phone']),
  'hint-phone-de': scene('de', 'phone', ['phone']),
  'hint-game': scene('it', 'game', ['desk', 'phone']),
  'hint-game-ja': scene('ja', 'game', ['phone']),
  'hint-dashboard': scene('it', 'dashboard', ['desk', 'edge']),
  'hint-dashboard-ru': scene('ru', 'dashboard', ['phone']),
  'hints-about': scene('it', 'about', ['desk', 'phone']),
};
