// The rail of Xenon (js/xenon-pages.js) in a language, open on Create and share: the
// group and page names are the longest in de, ru and ja; rail-content opens the Content group. scenes.mjs spreads these in.
/* global setLang, openSettings */

async function rail({ lang = 'it', page = 'sdk' } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(400);
  openSettings(page);
  await pause(1500);
  return null;
}

const scene = (lang, sizes, page) => ({ sizes, open: rail, arg: { lang, page } });

export const railScenes = {
  'rail-it': scene('it', ['desk', 'phone']),
  'rail-de': scene('de', ['desk', 'phone']),
  'rail-ru': scene('ru', ['desk']),
  'rail-ja': scene('ja', ['desk']),
  'rail-content-de': scene('de', ['desk'], 'weather'),
  // Where the dashboard opens, on Telefono since the old Schermo page joined Schermi.
  'rail-phone-it': scene('it', ['desk', 'phone'], 'phone'),
};
