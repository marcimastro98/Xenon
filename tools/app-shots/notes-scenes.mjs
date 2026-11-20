// The notes of a minor as an updater sees them (js/release-notes-card.js), with the row of
// server/whatsnew.json that says Xenon is one place: on the dashboard, and opened from the
// corner of "widgets only". tools/app-shots/scenes.mjs spreads these in. Run inside the
// page, so each takes the row and its language as the scene's `arg`, never from a closure.
/* global setLang, t */

import { readFileSync } from 'node:fs';

const WHATSNEW = JSON.parse(readFileSync(new URL('../../server/whatsnew.json', import.meta.url), 'utf8'));
const REL = WHATSNEW.releases.find((r) => r.version === '5.2.0');
const ROW = REL?.news[0];

async function releaseNotes({ lang = 'it', corner = false, row, rel } = {}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  setLang(lang);
  await pause(400);
  const text = (v) => (v && typeof v === 'object' ? v[lang] || v.en : v || '');
  const opts = {
    notes: rel || { version: '5.2.0', news: [row], fixes: [] }, text, tr: (k) => t(k),
    url: 'https://example.com/releases', openUrl() {}, menuKey: 'Alt+Shift+X', openXenon() {}, onClose() {},
  };
  if (corner) {
    window.XenonReleaseNotes.cornerNotes(opts);
    await pause(300);
    document.querySelector('.rn-corner-go').click();
  } else {
    window.XenonReleaseNotes.openNotes(opts);
  }
  await pause(1200);
  return null;
}

const scene = (lang, corner, sizes) => ({ sizes, open: releaseNotes, arg: { lang, corner, row: ROW } });

export const notesScenes = {
  'notes-xenon': scene('it', false, ['desk', 'phone', 'edge']),
  'notes-xenon-de': scene('de', false, ['phone', 'small-phone']),
  'notes-xenon-ru': scene('ru', false, ['desk', 'phone']),
  'notes-xenon-ja': scene('ja', false, ['phone']),
  'notes-xenon-corner': scene('it', true, ['desk', 'phone']),
  // The whole 5.2.0 notes, every row and fix, as an updater sees them.
  'notes-520-full': { sizes: ['desk', 'phone', 'edge'], open: releaseNotes, arg: { lang: 'it', rel: REL } },
  'notes-520-full-de': { sizes: ['phone'], open: releaseNotes, arg: { lang: 'de', rel: REL } },
};
