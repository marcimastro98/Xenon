// The settings a throwaway engine starts with when the save check runs
// (settings-save-check.mjs). Every value is invented. Every secret holds SECRET_MARK, so
// "no secret left this computer" is one search of an answer (the two folders on "this PC"
// count as secrets: a browser is never told them), and each secret's destination is an
// address of the documentation range (192.0.2.x), which nothing answers at.

import path from 'node:path';

export const SECRET_MARK = 'rig-secret-';

/** The top-level keys that hold a secret, and the secrets inside a block. */
export const SECRET_KEYS = ['geminiApiKey', 'openaiApiKey', 'anthropicApiKey', 'localApiKey', 'twelveDataKey', 'finnhubKey', 'sportsDbKey', 'newsDataKey', 'obsPassword', 'streamerbotPassword'];
export const NESTED_SECRETS = [['homeAssistant', 'token'], ['unifi', 'password'], ['remoteControl', 'sunshineUser'], ['remoteControl', 'sunshinePass']];

/**
 * @param {string} folder the rig's own folder: the paths on "this PC" the settings name are inside it
 * @returns {Record<string, any>}
 */
export function seedSettings(folder) {
  const secrets = Object.fromEntries(SECRET_KEYS.map((key) => [key, `${SECRET_MARK}${key}`]));
  return {
    ...secrets,
    language: 'it',
    lyricsOffsetMs: 300,
    obsHost: '192.0.2.10',
    streamerbotHost: '192.0.2.11',
    homeAssistant: { url: 'http://192.0.2.20:8123', token: `${SECRET_MARK}homeAssistant-token` },
    unifi: { host: '192.0.2.30', username: 'rig', password: `${SECRET_MARK}unifi-password` },
    remoteControl: { enabled: false, sunshineUser: `${SECRET_MARK}sunshineUser`, sunshinePass: `${SECRET_MARK}sunshinePass` },
    calendarFeeds: [{ id: 'rig-feed', name: 'Rig calendar', url: `https://calendar.example/${SECRET_MARK}feed.ics`, enabled: false, reminders: false }],
    fileTransfer: { enabled: true, inboxDir: path.join(folder, `${SECRET_MARK}inbox`), keepDays: 9 },
    capture: { fps: 30, folder: path.join(folder, `${SECRET_MARK}captures`) },
    lighting: { enabled: false, brightness: 0.4, effects: { musicAlbum: false, volume: true } },
    stocks: { watchlist: [{ symbol: 'RIGA', name: 'Rig A' }, { symbol: 'RIGB', name: 'Rig B' }], alertPercent: 3 },
    football: { teams: [{ id: '900001', name: 'Rig United', league: 'Rig League', leagueId: '9001' }], refreshSec: 300 },
    news: { feeds: [{ id: 'rig-topic', type: 'topic', name: 'Rig topic', query: 'rig' }], refreshSec: 900 },
    claude: { plan: 'custom', weeklyTokenBudget: 123456 },
    weather: { mode: 'manual', city: 'Rigtown' },
    layers: { enabled: false, menuPad: false, overlayKey: 'ctrl+shift+f8' },
    vitals: { state: { xp: 50, day: '2026-01-05', fills: 3, last: { hydration: 1767600000000 } } },
    firstRunDay: '2026-01-05',
    lastUsageDay: '2026-01-06',
    usageDays: 12,
    supportAskSeen: true,
    shareNudgeSeen: true,
    supportAskSeenDay: '2026-02-01',
    supportAppealYear: 2026,
    releaseNotesSeen: '5.0.0',
    updateFailSeen: '5.0.1',
    whatsNewSeen: '5.1.0',
    usageStats: false,
    batteryAskDevices: true,
    aiFeatures: { enabled: false, pcControl: false },
    appFavorites: [
      { key: 'rig-notes', app: 'Rig Notes', title: 'Rig Notes', path: path.join(folder, 'apps', 'rig-notes.exe') },
      { key: 'rig-paint', app: 'Rig Paint', title: 'Rig Paint', path: path.join(folder, 'apps', 'rig-paint.exe') },
    ],
    sdkWidgets: { enabled: true, grants: { 'rig.widget': { streams: ['system'], actions: [], hosts: [] } } },
  };
}
