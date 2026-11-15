// What stored settings are turned into before they are saved or sent, third part: the app's
// gestures and zoom, starting with the system, updates, anonymous counts, the cards already
// seen and the days the app was used.

const { clampNumber } = require('./values.js');
const { DAY_RE } = require('./usage-day.js');
const { normalizeSnowflakeList } = require('../discord/snowflake-list.js');
const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');

function normalizeHubApp(source) {
  return {
    swipeHomeGesture: source.swipeHomeGesture !== false,
    nativeZoom: clampNumber(source.nativeZoom, 0.6, 2.5, DEFAULT_HUB_SETTINGS.nativeZoom),
    hideOnRdp: source.hideOnRdp === true,
    audioSetCommunications: source.audioSetCommunications !== false,
    autoOpenBrowser: source.autoOpenBrowser !== false,
    // `=== true`: absent means nobody asked, on a new install and on one that updates.
    autoOpenArmed: source.autoOpenArmed === true,
    versionPing: source.versionPing === true,
    // `!== false` on purpose: absent means on, so existing installs keep getting
    // announcements and drop cards rather than being silently switched off by an
    // update. See the note on the defaults above.
    hubMessages: source.hubMessages !== false,
    catalogDrops: source.catalogDrops !== false,
    monthlyDrops: source.monthlyDrops !== false,
    autoUpdate: source.autoUpdate !== false,
    autoUpdateWidgets: source.autoUpdateWidgets !== false,
    catalogStats: source.catalogStats === true,
    ratingAsks: source.ratingAsks !== false,
    usageStats: source.usageStats === true,
    batteryAskDevices: source.batteryAskDevices !== false,
    // The release id the What's New modal was dismissed for, and the Discord
    // card's flag. Both `=== true`/bounded-string rather than `!== false`: an
    // absent key means "never dismissed", which is the honest reading of a blob
    // written before v4.11.6 — the client promotes the legacy localStorage value
    // over it on first hydrate when there is one.
    whatsNewSeen: typeof source.whatsNewSeen === 'string' ? source.whatsNewSeen.trim().slice(0, 64) : '',
    releaseNotesSeen: typeof source.releaseNotesSeen === 'string' ? source.releaseNotesSeen.trim().slice(0, 32) : '',
    updateFailSeen: typeof source.updateFailSeen === 'string' ? source.updateFailSeen.trim().slice(0, 64) : '',
    discordInviteSeen: source.discordInviteSeen === true,
    // Usage history. Server-owned; the POST guard below keeps a client save from
    // touching them. Bounded so a hand-edited file cannot make the ask unreachable
    // (a negative count) or claim a decade of use.
    firstRunDay: DAY_RE.test(String(source.firstRunDay || '')) ? String(source.firstRunDay) : '',
    lastUsageDay: DAY_RE.test(String(source.lastUsageDay || '')) ? String(source.lastUsageDay) : '',
    usageDays: clampNumber(Math.floor(Number(source.usageDays) || 0), 0, 100000, 0),
    supportAskSeen: source.supportAskSeen === true,
    supportAskSeenDay: DAY_RE.test(String(source.supportAskSeenDay || '')) ? String(source.supportAskSeenDay) : '',
    supportAppealYear: clampNumber(Math.floor(Number(source.supportAppealYear) || 0), 0, 9999, 0),
    shareNudgeSeen: source.shareNudgeSeen === true,
    // Snowflakes only, deduped and capped. This list is echoed straight back to
    // every surface and used as a DOM key, so anything that is not a Discord id
    // has no business surviving a round trip through the store.
    discordFavChannels: normalizeSnowflakeList(source.discordFavChannels),
    discordCollapsedGuilds: normalizeSnowflakeList(source.discordCollapsedGuilds),
  };
}

module.exports = { normalizeHubApp };
