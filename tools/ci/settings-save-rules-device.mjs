// The rules of POST /settings a paired device meets, each as one real save, in the shape
// settings-save-rules.mjs describes. `door` says who sends: the paired device, a device on
// the network that was never paired (`stranger`), or a page on this computer (`pc`): the
// same change is sent from this computer where the rule is "only this PC may", so the check
// also shows the engine does let the owner do it.
//
// In order: a rule relies on what the ones before it left stored, and says so in `given`.

import { same, show, took, unchanged, without } from './settings-save-rules.mjs';

const otherOffset = (now) => (now === 500 ? 700 : 500);
const pcControl = (on) => (mirror) => ({ ...mirror, aiFeatures: { ...mirror.aiFeatures, pcControl: on } });
const pcControlIs = (on) => ({ after }) => (after.aiFeatures?.pcControl === on ? '' : `PC Control is ${after.aiFeatures?.pcControl}`);
const flag = (key, on) => (settings) => ({ ...settings, [key]: on });
const flagIs = (key, on) => ({ after }) => (after[key] === on ? '' : `${key} is ${after[key]}`);
// A verdict for a switch this PC flips: it was the other way, and now it is `on`.
const turned = (read, name, on) => ({ before, after }) => {
  if (read(before) === on) return `${name} was ${on} already: nothing was proven`;
  return read(after) === on ? '' : `${name} is ${read(after)}`;
};

const NEW_FAVOURITE = { key: 'rig-shell', app: 'Rig Shell', title: 'Rig Shell', icon: '', path: 'rig-shell.exe' };
const NEW_GRANT = { streams: ['media'], actions: [], hosts: [] };
const grantsOf = (settings) => settings?.sdkWidgets?.grants ?? {};
const withGrants = (mirror, grants) => ({ ...mirror, sdkWidgets: { ...mirror.sdkWidgets, grants } });

export const DEVICE_RULES = [
  { rule: 'a device that was never paired cannot save', kind: 'guard', door: 'stranger', refused: 401, send: (mirror) => ({ ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) }) },
  { rule: "a page of another site cannot save with the paired device's cookie", kind: 'guard', door: 'device', headers: { Origin: 'http://attacker.example' }, refused: 403,
    send: (mirror) => ({ ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) }) },
  { rule: 'a paired device saves a setting the dashboard owns', kind: 'saved', door: 'device', send: (mirror) => ({ ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) }), verdict: took('lyricsOffsetMs') },
  { rule: 'a paired device cannot switch paired access off with a save', kind: 'guard', door: 'device', send: (mirror) => ({ ...mirror, remoteAccess: { enabled: false, https: false } }), verdict: unchanged('remoteAccess') },

  { rule: 'PC Control: a paired device cannot switch it on', kind: 'guard', door: 'device', send: pcControl(true), verdict: pcControlIs(false) },
  { rule: 'PC Control: this PC switches it on', kind: 'saved', door: 'pc', send: pcControl(true), verdict: turned((settings) => settings.aiFeatures?.pcControl, 'PC Control', true) },
  { rule: 'PC Control: a paired device cannot switch it off either, the stored choice stands', kind: 'guard', door: 'device', given: pcControl(true), send: pcControl(false), verdict: pcControlIs(true) },

  { rule: 'app favourites: a paired device reorders them, cannot add one, and cannot put another path under a saved name', kind: 'guard', door: 'device',
    send: (mirror) => {
      const [first, second] = mirror.appFavorites;
      return { ...mirror, appFavorites: [second, { ...first, path: 'another-program.exe' }, NEW_FAVOURITE] };
    },
    verdict: ({ before, after }) => {
      if (before.appFavorites?.length !== 2) return `the check needs two stored favourites, ${before.appFavorites?.length ?? 0} were stored`;
      const [first, second] = before.appFavorites;
      return same(after.appFavorites, [second, first]) ? '' : `stored ${show(after.appFavorites)}`;
    } },
  { rule: 'app favourites: a paired device removes one', kind: 'saved', door: 'device', send: (mirror) => ({ ...mirror, appFavorites: mirror.appFavorites.slice(0, 1) }),
    verdict: ({ before, after }) => (same(after.appFavorites, before.appFavorites.slice(0, 1)) ? '' : `stored ${show(after.appFavorites)}`) },
  { rule: 'app favourites: this PC adds one', kind: 'saved', door: 'pc', send: (mirror) => ({ ...mirror, appFavorites: [...mirror.appFavorites, NEW_FAVOURITE] }),
    verdict: ({ before, after }) => (after.appFavorites?.length === before.appFavorites.length + 1 && after.appFavorites.some((entry) => entry.key === NEW_FAVOURITE.key) ? '' : `stored ${show(after.appFavorites)}`) },

  { rule: "a widget's permissions: a paired device cannot grant one, and cannot widen one this PC granted", kind: 'guard', door: 'device',
    send: (mirror) => {
      const [held] = Object.keys(grantsOf(mirror));
      return withGrants(mirror, { [held]: { ...grantsOf(mirror)[held], streams: ['system', 'media', 'audio'], actions: ['launch'] }, 'rig.other': NEW_GRANT });
    },
    verdict: ({ before, after }) => {
      if (!Object.keys(grantsOf(before)).length) return 'no permission was stored before the save: nothing was proven';
      return same(grantsOf(after), grantsOf(before)) ? '' : `stored ${show(grantsOf(after))}`;
    } },
  { rule: "a widget's permissions: this PC grants one", kind: 'saved', door: 'pc', send: (mirror) => withGrants(mirror, { ...grantsOf(mirror), 'rig.other': NEW_GRANT }),
    verdict: ({ after }) => (Object.hasOwn(grantsOf(after), 'rig.other') ? '' : `stored ${show(grantsOf(after))}`) },
  { rule: "a widget's permissions: a paired device takes one away", kind: 'saved', door: 'device', given: (stored) => withGrants(stored, { ...grantsOf(stored), 'rig.other': NEW_GRANT }),
    send: (mirror) => withGrants(mirror, without(grantsOf(mirror), 'rig.other')),
    verdict: ({ before, after }) => {
      if (!Object.hasOwn(grantsOf(before), 'rig.other')) return 'the permission to take away was not stored: nothing was proven';
      return same(grantsOf(after), without(grantsOf(before), 'rig.other')) ? '' : `stored ${show(grantsOf(after))}`;
    } },

  { rule: 'the anonymous feature counts: a paired device cannot switch them on', kind: 'guard', door: 'device', send: flag('usageStats', true), verdict: flagIs('usageStats', false) },
  { rule: 'the anonymous feature counts: this PC switches them on', kind: 'saved', door: 'pc', send: flag('usageStats', true), verdict: turned((settings) => settings.usageStats, 'usageStats', true) },
  { rule: 'the anonymous feature counts: a paired device cannot switch them off', kind: 'guard', door: 'device', given: flag('usageStats', true), send: flag('usageStats', false), verdict: flagIs('usageStats', true) },
  { rule: 'the anonymous feature counts: this PC switches them off', kind: 'saved', door: 'pc', given: flag('usageStats', true), send: flag('usageStats', false), verdict: turned((settings) => settings.usageStats, 'usageStats', false) },

  { rule: 'asking devices for their battery: a paired device cannot switch it off', kind: 'guard', door: 'device', send: flag('batteryAskDevices', false), verdict: flagIs('batteryAskDevices', true) },
  { rule: 'asking devices for their battery: this PC switches it off', kind: 'saved', door: 'pc', send: flag('batteryAskDevices', false), verdict: turned((settings) => settings.batteryAskDevices, 'batteryAskDevices', false) },
  { rule: 'asking devices for their battery: a paired device cannot switch it on', kind: 'guard', door: 'device', given: flag('batteryAskDevices', false), send: flag('batteryAskDevices', true), verdict: flagIs('batteryAskDevices', false) },
];
