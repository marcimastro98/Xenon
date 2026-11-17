// What stored settings are turned into before they are saved or sent, second part: the
// screensaver, weather and units, music and lyrics, the top bar, widget layers, sensors and the
// upcoming list.

const { clampNumber } = require('./values.js');
const { normalizeTopbarRails, normalizeTopbarClock } = require('../topbar/settings-normalize.js');
const { normalizeSensorRate } = require('../system/settings-normalize.js');
const SensorSources = require('../js/system/sensor-sources.js');
const GameIgnore = require('../js/performance/game-ignore.js');
const TopbarLook = require('../js/topbar/topbar-look.js');
const LayersModel = require('../js/layers/layers-model.js');
const { cleanCap: cleanLyricsTranslateCap } = require('../media/lyrics-translator.js');
const { cleanDailyCap: cleanSdkAiDailyCap } = require('../widget-sdk/sdk-ai.js');
const { normalizeAmbientMode } = require('../ambient/normalize-mode.js');
const { normalizeSettingsWeather } = require('../weather/normalize-settings.js');

function normalizeHubScreen(source) {
  return {
    ambientMode: normalizeAmbientMode(source.ambientMode),
    weather: normalizeSettingsWeather(source.weather),
    tempUnit: source.tempUnit === 'f' ? 'f' : 'c',
    hwTempUnit: ['auto', 'c', 'f'].includes(source.hwTempUnit) ? source.hwTempUnit : 'auto',
    mediaVisualizer: ['off', 'minimal', 'wave'].includes(source.mediaVisualizer) ? source.mediaVisualizer : (source.mediaVisualizer === true ? 'wave' : 'off'),
    mediaLyrics: source.mediaLyrics !== false,
    lyricsOffsetMs: Math.round(clampNumber(source.lyricsOffsetMs, -3000, 3000, 0) / 100) * 100,
    lyricsTranslate: source.lyricsTranslate === true,
    lyricsReading: source.lyricsReading !== false,
    lyricsTranslateCap: cleanLyricsTranslateCap(source.lyricsTranslateCap),
    sdkAiDailyCap: cleanSdkAiDailyCap(source.sdkAiDailyCap),
    spotifyStartMinimized: source.spotifyStartMinimized === true,
    lyricsStage: source.lyricsStage === true,
    clockFormat: ['auto', '12', '24'].includes(source.clockFormat) ? source.clockFormat : 'auto',
    topbarStyle: source.topbarStyle === 'minimal' ? 'minimal' : 'full',
    topbarRails: normalizeTopbarRails(source.topbarRails),
    topbarRailsAutoHide: source.topbarRailsAutoHide !== false,
    topbarClock: normalizeTopbarClock(source.topbarClock, source),
    topbarLook: TopbarLook.normalize(source.topbarLook),
    layers: LayersModel.normalize(source.layers),
    // Sensor cadence (ms). Drives the system broadcast AND the caches under it:
    // broadcasting faster alone would only re-send readings up to 5s old.
    sensorRateMs: normalizeSensorRate(source.sensorRateMs),
    // Which sensor feeds CPU/GPU temperature and watts; {} = Automatic for all.
    // Same rule as the browser's normalizeSettings (js/system/sensor-sources.js).
    sensorSources: SensorSources.normalizeSensorSources(source.sensorSources),
    gameIgnore: GameIgnore.normalizeGameIgnore(source.gameIgnore),
    gameAlways: GameIgnore.normalizeGameIgnore(source.gameAlways), // "this is a game" (same rule)
    weekStart: ['mon', 'sun'].includes(source.weekStart) ? source.weekStart : 'mon',
    upcomingCount: [3, 5, 8, 10].includes(Number(source.upcomingCount)) ? Number(source.upcomingCount) : 5,
    upcomingDays: [0, 7, 14, 30].includes(Number(source.upcomingDays)) ? Number(source.upcomingDays) : 0,
    upcomingColumns: [0, 1, 2].includes(Number(source.upcomingColumns)) ? Number(source.upcomingColumns) : 0,
    swipeNavigation: source.swipeNavigation !== false,
  };
}

module.exports = { normalizeHubScreen };
