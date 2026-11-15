// What stored settings are turned into before they are saved or sent, sixth part: the opt-in
// features, notifications, calls and phone, the wake word, search, disk, backgrounds, the
// Claude, Codex and ChatGPT widgets, lighting and calendar feeds.

const os = require('node:os');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const {
  normalizeNotifications, normalizeDiscordNotifications, normalizeWindowsNotifications,
  normalizeCalls, normalizePhone,
} = require('./normalize-notifications.js');
const {
  normalizeServerAiFeatures, normalizeProactive, normalizeWakeWord,
} = require('../ai/settings-normalize.js');
const { normalizeSearchSettings } = require('../search/settings-normalize.js');
const { normalizePageHotkeys } = require('../grid/page-hotkeys-normalize.js');
const { normalizeDiskSettings } = require('../disk/settings-normalize.js');
const { normalizeServerFanLabels } = require('../system/settings-normalize.js');
const { normalizeGameSessionsSetting } = require('../performance/settings-normalize.js');
const { normalizeClaudeWidget } = require('../claude-code/settings-normalize.js');
const { normalizeCodexWidget } = require('../codex/settings-normalize.js');
const { CALENDAR_FEED_PALETTE } = require('../time/events-normalize.js');
const SensorHistory = require('../js/sensor-history.js');
const PerfHud = require('../js/performance/perf-hud.js');
const aiCli = require('../ai-cli.js');
const icsFeeds = require('../time/ics-feeds.js');
const { normalizeVitals } = require('../vitals/settings-normalize.js');
const { normalizeBgCustom } = require('../look/background-custom-normalize.js');
const { normalizeSlideshow } = require('../windows-tiles/slideshow-normalize.js');
const {
  normalizeBgAurora, normalizeBgStatic, normalizeBgGrid,
} = require('../look/normalize-backgrounds.js');
const { normalizeLighting } = require('../lights/normalize-settings.js');

function normalizeHubFeatures(source) {
  return {
    aiFeatures: normalizeServerAiFeatures(source.aiFeatures),
    sensorHistory: SensorHistory.normalizeSensorHistory(source.sensorHistory),
    gameSessions: normalizeGameSessionsSetting(source.gameSessions),
    perfHud: PerfHud.normalizePerfHud(source.perfHud),
    // User fan names for the Fans widget ("mb|Fan #3" → "Radiatore alto").
    // Client-owned but flat enough to validate explicitly at this boundary.
    fanLabels: normalizeServerFanLabels(source.fanLabels),
    proactive: normalizeProactive(source.proactive),
    notifications: normalizeNotifications(source.notifications),
    vitals: normalizeVitals(source.vitals),
    discordNotifications: normalizeDiscordNotifications(source.discordNotifications),
    windowsNotifications: normalizeWindowsNotifications(source.windowsNotifications),
    calls: normalizeCalls(source.calls),
    phone: normalizePhone(source.phone),
    wakeWord: normalizeWakeWord(source.wakeWord),
    // The server is the one side that knows the machine, so it supplies the
    // never-set default; the browser's copy of this normalizer keeps whatever
    // the server already chose.
    searchSettings: normalizeSearchSettings(source.searchSettings, POWERSHELL_SUPPORTED ? 'C:\\' : os.homedir()),
    pageHotkeys: normalizePageHotkeys(source.pageHotkeys),
    diskSettings: normalizeDiskSettings(source.diskSettings),
    bgAurora: normalizeBgAurora(source.bgAurora),
    bgGrid: normalizeBgGrid(source.bgGrid),
    bgStatic: normalizeBgStatic(source.bgStatic),
    bgCustom: normalizeBgCustom(source.bgCustom),
    slideshow: normalizeSlideshow(source.slideshow),
    claudeWidget: normalizeClaudeWidget(source.claudeWidget),
    codexWidget: normalizeCodexWidget(source.codexWidget),
    chatgptWidget: { model: aiCli.sanitizeModel(source.chatgptWidget && source.chatgptWidget.model) },
    lighting: normalizeLighting(source.lighting),
    calendarFeeds: icsFeeds.normalizeCalendarFeeds(source.calendarFeeds, CALENDAR_FEED_PALETTE),
  };
}

module.exports = { normalizeHubFeatures };
