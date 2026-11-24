// Settings → Performance with the RivaTuner row (js/settings/perf-hud-rtss.js):
// off, on with RivaTuner closed (the Download row shows) and on while it draws over a game.
// The state is invented here, as GET /api/gamemode/status would send it. scenes.mjs spreads these in.
/* global setLang, openSettings */

const URL = 'https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download';

async function rtss({ lang = 'it', state } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(400);
  openSettings('performance');
  await pause(1200);
  window.PerfHudRtss.sync({ ...state, url: URL });
  document.getElementById('settings-perfhud-rtss')?.closest('label')?.scrollIntoView({ block: 'center' });
  await pause(400);
  return null;
}

const scene = (lang, sizes, state) => ({ sizes, open: rtss, arg: { lang, state } });
const OFF = { on: false, running: false, showing: false };
const CLOSED = { on: true, running: false, showing: false };
const SHOWING = { on: true, running: true, showing: true };

export const rtssScenes = {
  'rtss-off-en': scene('en', ['desk', 'phone'], OFF),
  'rtss-closed-it': scene('it', ['desk', 'phone'], CLOSED),
  'rtss-closed-de': scene('de', ['phone'], CLOSED),
  'rtss-showing-ja': scene('ja', ['desk'], SHOWING),
};
