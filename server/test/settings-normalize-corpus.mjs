// What normalizeHubSettings is asked in settings-normalize-behaviour.test.mjs, and how an
// answer is written down. Every value is invented; nothing here reads the code under test,
// so the same questions are asked whatever the function looks like inside.

import { createHash } from 'node:crypto';

const LONG = 160;

/** A value as text: key order kept, and the values JSON drops or bends written out. */
export function show(value, mask = (text) => text) {
  return JSON.stringify(value, (_key, held) => {
    if (held === undefined) return '<undefined>';
    if (typeof held === 'function') return '<function>';
    if (typeof held === 'number' && !Number.isFinite(held)) return `<${held}>`;
    return typeof held === 'string' ? mask(held) : held;
  });
}

export const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)} (${text.length} chars)`;
/** A text short enough to read, or its digest. */
export const brief = (text) => (text.length <= LONG ? text : digest(text));

// One value of every kind a settings file can hold, and the words and numbers the settings use.
const WORDS = ['light', 'dark', 'auto', 'liquid', 'glass', 'retro', 'comic', 'full', 'medium', 'short', 'f', 'c', 'off', 'minimal', 'wave',
  '12', '24', 'mon', 'sun', 'main', 'second', 'all', 'it', 'en', 'on', '#ff8800', '#FFF', 'not-a-colour', '2026-01-05', '2026-13-45', '5.1.0',
  'http://192.0.2.10:8123', 'https://service.example/path', '192.0.2.10', 'gemini', 'ollama', 'local', 'gpt-rig-1', 'auto:flash',
  '  padded  ', '123456789012345678', 'f'.repeat(32)];
const NUMBERS = [-1, 0, 1, 2, 3, 5, 7, 8, 10, 14, 24, 30, 0.5, 1.5, 100, 150, 1000, 2000, 4455, 70000, 1e12, 2027];
export const BATTERY = [
  ['null', null], ['true', true], ['false', false],
  ...NUMBERS.map((number) => [String(number), number]), ['NaN', NaN], ['Infinity', Infinity],
  ['""', ''], ...WORDS.map((word) => [JSON.stringify(word), word]), ['5000 letters', 'x'.repeat(5000)], ['"8080"', '8080'],
  ['[]', []], ['[1,"a",null]', [1, 'a', null]], ['three ids', ['123456789012345678', '123456789012345678', 'nope', '223456789012345678']],
  ['{}', {}], ['{enabled:true}', { enabled: true }], ['{enabled:false}', { enabled: false }], ['{enabled:"yes",extra:1}', { enabled: 'yes', extra: 1 }],
  ['nested', { a: { b: { c: [1, { d: null }] } }, list: [[], [[]]] }], ['{topbar:false}', { topbar: false }], ['{topbar:true}', { topbar: true }],
  ['{kind:"phone",asked:true}', { kind: 'phone', asked: true, monitor: 'Rig Screen', label: 'Rig' }],
];

/** Every leaf of a value with the path to it, lists included, up to `limit`. */
export function leavesOf(value, limit = 60) {
  const found = [];
  const walk = (held, path) => {
    if (found.length >= limit) return;
    if (held !== null && typeof held === 'object') {
      for (const [key, inner] of Object.entries(held)) walk(inner, [...path, key]);
      return;
    }
    found.push({ path, value: held });
  };
  walk(value, []);
  return found;
}

/** A copy of `value` with the leaf at `path` replaced. */
export function withLeaf(value, path, leaf) {
  if (path.length === 0) return leaf;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[path[0]] = withLeaf(value[path[0]], path.slice(1), leaf);
  return copy;
}

/** Other values a leaf could hold: the switch flipped, the number moved, the text changed. */
export function otherLeaves(leaf) {
  if (typeof leaf === 'boolean') return [!leaf];
  if (typeof leaf === 'number') return [leaf + 1, leaf * 2 + 3, -leaf - 1];
  if (typeof leaf === 'string') return [`${leaf}x`, '', 'auto'];
  return [true, 1, 'text'];
}

/** A settings file a person could have: invented names, addresses of the documentation range, example domains. */
export function realistic(defaults) {
  return {
    appearance: 'light', autoPalette: true, styleMode: 'retro', retroScanlines: false, accent: '#12ab34', background: '#101820', surface: '#202830',
    text: '#f0f0f0', panelAlpha: 0.7, bgDim: 0.4, bgBlur: 6, uiRoundness: 1.5, glassBlur: 20, clockScale: 1.4, clockDateFormat: 'short',
    tempUnit: 'f', hwTempUnit: 'c', mediaVisualizer: 'minimal', mediaLyrics: false, lyricsOffsetMs: 340, lyricsTranslate: true, clockFormat: '24',
    topbarStyle: 'minimal', topbarRailsAutoHide: false, weekStart: 'sun', upcomingCount: 8, upcomingDays: 14, upcomingColumns: 2,
    swipeNavigation: false, nativeZoom: 1.25, hideOnRdp: true, versionPing: true, hubMessages: false, autoUpdate: false, catalogStats: true,
    usageStats: true, batteryAskDevices: false, whatsNewSeen: ' 5.1.0 ', releaseNotesSeen: '5.0.0', updateFailSeen: '5.0.1', discordInviteSeen: true,
    firstRunDay: '2026-01-05', lastUsageDay: '2026-01-06', usageDays: 12.7, supportAskSeen: true, supportAskSeenDay: '2026-02-01',
    supportAppealYear: 2026, shareNudgeSeen: true, discordFavChannels: ['123456789012345678', '223456789012345678'], browserAdblock: true,
    dashboardLayoutVersion: defaults.dashboardLayoutVersion, dashboardLayout: { ...defaults.dashboardLayout, topbarHidden: !defaults.dashboardLayout.topbarHidden },
    geminiApiKey: '  rig-key-gemini  ', obsHost: ' 192.0.2.10 ', obsPort: '4466', obsPassword: 'rig-obs', obsAutoLaunch: false,
    streamerbotHost: '192.0.2.11', streamerbotPort: 99999, streamerbotPassword: 'rig-sb',
    browserFavorites: [{ title: 'Rig site', url: 'https://service.example/' }],
    appFavorites: [{ key: 'rig-notes', app: 'Rig Notes', title: 'Rig Notes', path: 'rig-notes.exe' }],
    aiProvider: 'ollama', ollamaModel: 'rig-model:1b', ollamaUrl: 'http://127.0.0.1:11434', localApiUrl: 'http://127.0.0.1:1234/v1', localApiModel: 'rig-local',
    localApiKey: 'rig-key-local', localApiVision: true, openaiApiKey: 'rig-key-openai', anthropicApiKey: 'rig-key-anthropic', aiTtsEnabled: false,
    aiMicSensitivity: 80, aiChatHidden: true, aiMemory: false, aiProReasoning: true, aiLiveVoice: true, aiEdgeGlow: 'second',
    aiFeatures: { enabled: true, pcControl: true }, fanLabels: { 'mb|Fan #3': 'Rig top fan' },
    vitals: { enabled: true, topbar: true, state: { xp: 50, day: '2026-01-05', fills: 3, last: { hydration: 1767600000000 } } },
    claudeWidget: { topbar: false }, chatgptWidget: { model: 'gpt-rig-1' },
    lighting: { enabled: true, brightness: 0.4, effects: { musicAlbum: false, volume: true } },
    calendarFeeds: [{ id: 'rig-feed', name: 'Rig calendar', url: 'https://calendar.example/rig.ics', enabled: true, reminders: false }],
    stocks: { watchlist: [{ symbol: 'RIGA', name: 'Rig A' }, { symbol: 'RIGB', name: 'Rig B' }], alertPercent: 3 }, twelveDataKey: 'rig-key-twelve',
    finnhubKey: 'rig-key-finnhub', football: { teams: [{ id: '900001', name: 'Rig United', league: 'Rig League', leagueId: '9001' }], refreshSec: 300 },
    sportsDbKey: 'rig-key-sports', news: { feeds: [{ id: 'rig', type: 'topic', name: 'Rig topic', query: 'rig' }], refreshSec: 900 }, newsDataKey: 'rig-key-news',
    claude: { plan: 'custom', weeklyTokenBudget: 123456 }, homeAssistant: { url: 'http://192.0.2.20:8123', token: 'rig-token' },
    unifi: { host: '192.0.2.30', username: 'rig', password: 'rig-password' }, chroma: { enabled: true }, signalrgb: { enabled: true },
    remoteControl: { enabled: true, sunshineUser: 'rig', sunshinePass: 'rig-pass' }, remoteAccess: { enabled: true, https: true },
    fileTransfer: { enabled: true, keepDays: 9 }, capture: { fps: 30 }, surfaceChoice: { kind: 'both', asked: true, monitor: 'Rig Screen', label: 'Rig' },
    gameMode: false, bgGuard: false, safeMode: true, performance: { mode: 'eco', fps: 30 }, contextProfiles: { rules: [{ app: 'rig.exe', page: 2 }] },
    secondScreen: { fps: 15 }, sdkWidgets: { enabled: true, grants: { 'rig.widget': { streams: ['system'], actions: [], hosts: [] } } },
    weather: { mode: 'manual', city: 'Rigtown' }, layers: { enabled: true, menuPad: false, overlayKey: 'ctrl+shift+f8' },
    rev: 41.9, storeId: 'a'.repeat(32), onboarding: { done: true, step: 3 }, language: 'it', somethingUnknown: { kept: false },
  };
}

/** The settings a version of the layout is asked with: the version stored, and whether a layout of the user's is stored. */
export function layoutQuestions(defaults) {
  const current = defaults.dashboardLayoutVersion;
  const versions = [['no version', undefined], ['0', 0], ['one before', current - 1], ['current', current], ['one after', current + 1],
    ['current as text', String(current)], ['a word', 'six'], ['null', null]];
  const layouts = [['no layout', undefined], ['a layout of the user', { ...defaults.dashboardLayout, topbarHidden: !defaults.dashboardLayout.topbarHidden }], ['a broken layout', 'broken']];
  return versions.flatMap(([version, stored]) => layouts.map(([layout, held]) => ({
    label: `${version}, ${layout}`,
    input: { ...(stored === undefined ? {} : { dashboardLayoutVersion: stored }), ...(held === undefined ? {} : { dashboardLayout: held }) },
  })));
}

/** Settings where one key is read to work out another. */
export const TOGETHER = [
  ['the screen choice under its old name', { surface: { kind: 'phone', asked: true, monitor: 'Rig Screen', label: 'Rig' } }],
  ['the old name next to the new one', { surface: { kind: 'phone' }, surfaceChoice: { kind: 'screen' } }],
  ['a colour under the old name stays a colour', { surface: '#202830', surfaceChoice: { kind: 'both' } }],
  ['automatic appearance without a palette choice', { appearance: 'auto' }],
  ['automatic appearance with the palette switched off', { appearance: 'auto', autoPalette: false }],
  ['the language of a first news list', { language: 'it' }],
  ['a language with a stored news list', { language: 'it', news: { feeds: [{ id: 'rig', type: 'topic', name: 'Rig topic', query: 'rig' }] } }],
  ['the bar items a widget hid', { claudeWidget: { topbar: false }, vitals: { topbar: true } }],
  ['a key the settings do not have', { somethingUnknown: 1, anotherOne: { deep: true } }],
];
