// What stored settings are turned into before they are saved or sent, seventh part: stocks,
// football, news and the ticker, the smart home, lighting bridges, paired devices, screen
// capture and file transfer.

const CaptureSettings = require('../capture-settings.js');
const { normalizeTicker } = require('../ticker/settings-normalize.js');
const { normalizeWaveLinkSettings } = require('../audio/wavelink-values.js');
const { normalizeHomeAssistant } = require('../actions/home-assistant.js');
const { normalizeRemoteControl } = require('../remote-control/settings.js');
const { normalizeUnifi } = require('../actions/unifi.js');
const stocks = require('../ticker/stocks.js');
const football = require('../ticker/football.js');
const news = require('../ticker/news.js');
const claudeUsage = require('../claude-code/claude-usage.js');
const { normalizeFileTransfer } = require('../transfer/normalize-settings.js');

function normalizeHubConnections(source) {
  return {
    stocks: stocks.normalizeStocks(source.stocks),
    twelveDataKey: String(source.twelveDataKey || '').trim().slice(0, 120),
    finnhubKey: String(source.finnhubKey || '').trim().slice(0, 120),
    football: football.normalizeFootball(source.football),
    sportsDbKey: String(source.sportsDbKey || '').trim().slice(0, 60),
    // The language goes in so a FIRST feed set is built in it. Nothing else in
    // here reads it: an existing list is the user's and is never rewritten.
    news: news.normalizeNews(source.news, source.language),
    newsDataKey: String(source.newsDataKey || '').trim().slice(0, 120),
    claude: claudeUsage.normalizeClaude(source.claude),
    ticker: normalizeTicker(source.ticker),
    homeAssistant: normalizeHomeAssistant(source.homeAssistant),
    unifi: normalizeUnifi(source.unifi),
    // Razer Chroma / Elgato Wave Link — local hardware SDKs, opt-in (no secrets,
    // just an enable flag; Wave Link optionally pins a port, 0 = auto-scan).
    chroma: { enabled: !!(source.chroma && source.chroma.enabled === true) },
    // SignalRGB scene switcher — opt-in enable flag (Windows-only; no secrets).
    signalrgb: { enabled: !!(source.signalrgb && source.signalrgb.enabled === true) },
    wavelink: normalizeWaveLinkSettings(source.wavelink),
    remoteControl: normalizeRemoteControl(source.remoteControl),
    // Paired-device access: one boolean, and nothing else lives here. The
    // devices and their tokens are in DATA_DIR/remote-devices.json, NOT in
    // settings — settings.json is mirrored to the browser and to localStorage
    // on every surface, which is the last place a credential should sit.
    remoteAccess: {
      enabled: source.remoteAccess && source.remoteAccess.enabled === true,
      https: source.remoteAccess && source.remoteAccess.https === true,
    },
    fileTransfer: normalizeFileTransfer(source.fileTransfer),
    capture: CaptureSettings.normalizeCaptureSettings(source.capture),
  };
}

module.exports = { normalizeHubConnections };
