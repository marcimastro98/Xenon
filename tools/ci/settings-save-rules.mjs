// The rules of POST /settings a dashboard on this computer meets, each as one real save
// (settings-save-check.mjs asks them of a throwaway engine, in this order: a rule may rely
// on what an earlier one left stored).
//
// A rule: `send(mirror, before)` gives the settings the page posts, built from the settings
// that page was sent (`mirror`); `verdict` reads the store before and after and says what
// went wrong, or ''. `given` (a rule that relies on an earlier one) gives the store that
// rule needs from the store it would otherwise find, and the check refuses to judge the rule
// when the store is not so. `kind` says what a broken engine does to it: a `guard` fails on an
// engine that stores whatever it is sent, a `saved` fails on an engine that stores nothing.
// The test of this file runs both such engines, so no rule here can pass by saying nothing.

import { NESTED_SECRETS, SECRET_KEYS, SECRET_MARK } from './settings-save-seed.mjs';

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};
/** Whether two values hold the same, whatever the order of their keys. */
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
export const show = (value) => String(JSON.stringify(value)).slice(0, 140);
export const without = (object, ...keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([name]) => !keys.includes(name)));

/** Every secret a settings object holds, by where it is. */
export function secretsOf(settings) {
  const found = {};
  for (const key of SECRET_KEYS) found[key] = settings?.[key] ?? '';
  for (const [block, field] of NESTED_SECRETS) found[`${block}.${field}`] = settings?.[block]?.[field] ?? '';
  (settings?.calendarFeeds ?? []).forEach((feed, index) => { found[`calendarFeeds.${index}.url`] = feed?.url ?? ''; });
  found['fileTransfer.inboxDir'] = settings?.fileTransfer?.inboxDir ?? '';
  found['capture.folder'] = settings?.capture?.folder ?? '';
  return found;
}

/** A verdict: these top-level keys are after the save what they were before it, and the page did send something else. */
export function unchanged(...keys) {
  return ({ before, after, sent }) => {
    const moved = keys.filter((key) => !same(before[key], after[key]));
    if (moved.length) return moved.map((key) => `${key} was ${show(before[key])}, the save made it ${show(after[key])}`).join('; ');
    return keys.every((key) => same(sent[key], before[key])) ? 'the page sent what was stored: nothing was proven' : '';
  };
}

/** A verdict: this top-level key now holds what the page sent, and that is not what was stored. */
export function took(key, part) {
  const read = (settings) => (part ? settings?.[key]?.[part] : settings?.[key]);
  const name = part ? `${key}.${part}` : key;
  return ({ before, after, sent }) => {
    if (!same(read(after), read(sent))) return `${name} reads ${show(read(after))}, ${show(read(sent))} was saved`;
    return same(read(before), read(sent)) ? `${name} already held what the page sent: nothing was proven` : '';
  };
}

// A key the engine owns: one save that carries another value, one that leaves the key out.
function serverOwned(what, key, change) {
  return [
    { rule: `${what}: a save that carries another value changes nothing`, kind: 'guard', send: (mirror) => ({ ...mirror, [key]: change(mirror[key]) }), verdict: unchanged(key) },
    { rule: `${what}: a save that leaves it out changes nothing`, kind: 'guard', send: (mirror) => without(mirror, key), verdict: unchanged(key) },
  ];
}

// A list a widget owns inside a block the settings page edits: the list stays, the rest is saved.
function ownedList(what, key, list, other, value) {
  const listKept = ({ before, after, sent }) => {
    if (!same(before[key]?.[list], after[key]?.[list])) return `${key}.${list} was ${show(before[key]?.[list])}, the save made it ${show(after[key]?.[list])}`;
    return same(sent[key]?.[list], before[key]?.[list]) ? 'the page sent the stored list: nothing was proven' : '';
  };
  return [
    { rule: `${what}: a save that carries another list changes nothing`, kind: 'guard', send: (mirror) => ({ ...mirror, [key]: { ...mirror[key], [list]: [] } }), verdict: listKept },
    { rule: `${what}: a save that leaves the whole block out changes nothing`, kind: 'guard', send: (mirror) => without(mirror, key), verdict: listKept },
    { rule: `${what}: the rest of the block is the settings page's and is saved`, kind: 'saved',
      send: (mirror) => ({ ...mirror, [key]: { ...mirror[key], [other]: value(mirror[key][other]) } }), verdict: took(key, other) },
  ];
}

const otherOffset = (now) => (now === 500 ? 700 : 500);
const NEW_PLACES = { obsHost: '192.0.2.110', haUrl: 'http://192.0.2.120:8123', unifiHost: '192.0.2.130' };

export const PC_RULES = [
  { rule: 'a setting the dashboard owns is saved', kind: 'saved', send: (mirror) => ({ ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) }), verdict: took('lyricsOffsetMs') },
  { rule: 'a save gets a number higher than the stored one, whatever number the page sent', kind: 'guard', send: (mirror) => ({ ...mirror, rev: 0 }),
    verdict: ({ before, after, answer }) => (after.rev > before.rev && answer.json?.rev === after.rev ? '' : `rev ${before.rev} -> ${after.rev}, the answer said ${answer.json?.rev}`) },
  { rule: 'the answer to a save is a short receipt, without a copy of the settings', kind: 'guard', send: (mirror) => mirror,
    verdict: ({ answer }) => (answer.json?.ok === true && same(Object.keys(answer.json).sort(), ['lightingApplied', 'ok', 'rev', 'savedAt']) ? '' : `the answer holds ${Object.keys(answer.json ?? {}).join(', ') || 'nothing'}`) },
  { rule: 'a page of another site cannot save through this computer', kind: 'guard', headers: { Origin: 'http://attacker.example' }, refused: 403, send: (mirror) => ({ ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) }) },

  { rule: 'a save that carries no secret keeps every stored secret', kind: 'guard', send: (mirror) => mirror,
    verdict: ({ before, after, sent }) => {
      if (JSON.stringify(sent).includes(SECRET_MARK)) return 'the page had been sent a secret: nothing was proven';
      const was = secretsOf(before);
      const now = secretsOf(after);
      const lost = Object.keys(was).filter((key) => !was[key] || now[key] !== was[key]);
      return lost.length ? `not stored any more, or never stored: ${lost.join(', ')}` : '';
    } },
  { rule: 'a key the user clears in the settings is cleared', kind: 'saved', send: (mirror) => ({ ...mirror, openaiApiKey: '', openaiApiKeySet: false }),
    verdict: ({ before, after }) => (before.openaiApiKey && after.openaiApiKey === '' ? '' : `openaiApiKey was ${before.openaiApiKey ? 'set' : 'empty'} and is ${after.openaiApiKey ? 'still set' : 'empty'}`) },
  { rule: 'a password or token is not kept for a new destination', kind: 'guard',
    send: (mirror) => ({ ...mirror, obsHost: NEW_PLACES.obsHost, homeAssistant: { ...mirror.homeAssistant, url: NEW_PLACES.haUrl }, unifi: { ...mirror.unifi, host: NEW_PLACES.unifiHost } }),
    verdict: ({ before, after }) => {
      const pairs = [['obsPassword', before.obsPassword, after.obsPassword], ['homeAssistant.token', before.homeAssistant?.token, after.homeAssistant?.token], ['unifi.password', before.unifi?.password, after.unifi?.password]];
      const unset = pairs.filter(([, was]) => !was).map(([name]) => name);
      if (unset.length) return `not stored before the save: ${unset.join(', ')}`;
      const carried = pairs.filter(([, , now]) => now).map(([name]) => name);
      return carried.length ? `carried to the new address: ${carried.join(', ')}` : '';
    } },

  ...serverOwned('the lighting settings', 'lighting', (value) => ({ ...value, enabled: !value.enabled, brightness: 0.9, effects: { ...value.effects, musicAlbum: !value.effects.musicAlbum } })),
  ...ownedList('the stocks watchlist', 'stocks', 'watchlist', 'alertPercent', (now) => (now === 5 ? 4 : 5)),
  ...ownedList('the followed football teams', 'football', 'teams', 'alerts', (now) => !now),
  ...ownedList('the followed news feeds', 'news', 'feeds', 'refreshSec', (now) => (now === 1800 ? 900 : 1800)),
  ...serverOwned('the Claude plan and budget', 'claude', (value) => ({ ...value, weeklyTokenBudget: 1 })),
  ...serverOwned('paired access', 'remoteAccess', () => ({ enabled: false, https: false })),
  ...serverOwned('the file transfer settings', 'fileTransfer', (value) => ({ ...value, enabled: !value.enabled, keepDays: 30, inboxDir: 'elsewhere' })),
  ...serverOwned('the recording options', 'capture', (value) => ({ ...value, fps: 120, folder: 'elsewhere' })),
  ...serverOwned('the widgets on the screen', 'layers', (value) => ({ ...value, menuPad: !value.menuPad, overlayKey: 'ctrl+shift+f7' })),
  ...serverOwned('the weather place', 'weather', (value) => ({ ...value, mode: 'manual', city: 'Elsewhere' })),
  ...serverOwned('the identity of the settings store', 'storeId', () => 'f'.repeat(32)),

  { rule: "the dashboard's layout is saved", kind: 'saved',
    send: (mirror) => ({ ...mirror, dashboardLayout: { ...mirror.dashboardLayout, topbarHidden: !mirror.dashboardLayout.topbarHidden } }), verdict: took('dashboardLayout', 'topbarHidden') },
  { rule: 'a save that does not say which layout version it holds does not put the factory layout back', kind: 'guard', send: (mirror) => without(mirror, 'dashboardLayoutVersion'),
    verdict: ({ before, after }) => (same(before.dashboardLayout, after.dashboardLayout) && after.dashboardLayoutVersion === before.dashboardLayoutVersion
      ? '' : `the layout or its version changed (version ${before.dashboardLayoutVersion} -> ${after.dashboardLayoutVersion})`) },
  { rule: 'a save from a page that does not speak 24 columns keeps the stored layout and every section it left out', kind: 'guard',
    send: (mirror) => ({ lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs), dashboardLayout: { ...without(mirror.dashboardLayout, 'gridCols'), topbarHidden: !mirror.dashboardLayout.topbarHidden } }),
    verdict: ({ before, after, sent }) => {
      const moved = Object.keys(before).filter((key) => !['lyricsOffsetMs', 'rev'].includes(key) && !same(before[key], after[key]));
      if (moved.length) return `changed: ${moved.join(', ')}`;
      return after.lyricsOffsetMs === sent.lyricsOffsetMs ? '' : 'the one setting the page did send was not saved';
    } },

  { rule: 'the usage history: a save that carries other days changes nothing', kind: 'guard', send: (mirror) => ({ ...mirror, firstRunDay: '2020-02-02', lastUsageDay: '2020-02-03', usageDays: 1 }), verdict: unchanged('firstRunDay', 'lastUsageDay', 'usageDays') },
  { rule: 'the usage history: a save that leaves it out changes nothing', kind: 'guard', send: (mirror) => without(mirror, 'firstRunDay', 'lastUsageDay', 'usageDays'), verdict: unchanged('firstRunDay', 'lastUsageDay', 'usageDays') },
  { rule: 'an ask the user dismissed stays dismissed', kind: 'guard', send: (mirror) => ({ ...mirror, supportAskSeen: false, shareNudgeSeen: false, supportAskSeenDay: '' }), verdict: unchanged('supportAskSeen', 'shareNudgeSeen', 'supportAskSeenDay') },
  { rule: 'which update notices were seen is not a page\'s to write', kind: 'guard', send: (mirror) => ({ ...mirror, releaseNotesSeen: '9.9.9', updateFailSeen: '9.9.8' }), verdict: unchanged('releaseNotesSeen', 'updateFailSeen') },
  { rule: "the What's New a user closed is not emptied by a page that has not heard", kind: 'guard', send: (mirror) => ({ ...mirror, whatsNewSeen: '' }), verdict: unchanged('whatsNewSeen') },
  { rule: "a page that closes a newer What's New saves it", kind: 'saved', send: (mirror) => ({ ...mirror, whatsNewSeen: '9.9.7' }), verdict: took('whatsNewSeen') },
  { rule: 'the year of the support appeal does not go back', kind: 'guard', send: (mirror) => ({ ...mirror, supportAppealYear: mirror.supportAppealYear - 1 }), verdict: unchanged('supportAppealYear') },
  { rule: 'a later year of the support appeal is saved', kind: 'saved', send: (mirror) => ({ ...mirror, supportAppealYear: mirror.supportAppealYear + 1 }), verdict: took('supportAppealYear') },
  { rule: 'the vitals state does not go back: points, the day, its refills, the last times', kind: 'guard',
    send: (mirror) => ({ ...mirror, vitals: { ...mirror.vitals, state: { ...mirror.vitals.state, xp: 1, day: '2025-12-31', fills: 0, last: { ...mirror.vitals.state.last, hydration: 5 } } } }),
    verdict: ({ before, after }) => {
      const pick = (settings) => { const state = settings.vitals?.state ?? {}; return { xp: state.xp, day: state.day, fills: state.fills, hydration: state.last?.hydration }; };
      if (!(pick(before).xp > 1)) return 'no vitals state was stored before the save: nothing was proven';
      return same(pick(before), pick(after)) ? '' : `was ${show(pick(before))}, the save made it ${show(pick(after))}`;
    } },
  { rule: 'more vitals points are saved', kind: 'saved', send: (mirror) => ({ ...mirror, vitals: { ...mirror.vitals, state: { ...mirror.vitals.state, xp: mirror.vitals.state.xp + 10 } } }),
    verdict: ({ before, after }) => (after.vitals?.state?.xp === before.vitals.state.xp + 10 ? '' : `points read ${after.vitals?.state?.xp}, ${before.vitals.state.xp + 10} was saved`) },
];
