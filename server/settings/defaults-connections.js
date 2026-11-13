// What a new install starts with, seventh part: stocks, football, news and the ticker, the
// smart home, paired devices, screen capture and file transfer.

const CaptureSettings = require('../capture-settings.js');
const stocks = require('../stocks.js');
const football = require('../football.js');
const news = require('../news.js');
const claudeUsage = require('../claude-usage.js');

const HUB_DEFAULTS_CONNECTIONS = Object.freeze({
  // Stock-market (Borsa) widget + ticker. Watchlist/provider/refresh are
  // client-visible; the optional provider API keys below are server-only secrets.
  stocks: stocks.DEFAULT_STOCKS,
  twelveDataKey: '',   // optional Twelve Data key (server-only; preserve+redact)
  finnhubKey: '',      // optional Finnhub key (server-only; preserve+redact)
  // Football (Calcio) widget + ticker. teams/refresh are client-visible; the
  // optional TheSportsDB Premium key below is a server-only secret.
  football: football.DEFAULT_FOOTBALL,
  sportsDbKey: '',     // optional TheSportsDB Premium key (server-only; preserve+redact)
  // News widget + ticker. feeds/refresh are client-visible; the optional
  // NewsData.io key below is a server-only secret.
  news: news.DEFAULT_NEWS,
  newsDataKey: '',     // optional NewsData.io key (server-only; preserve+redact)
  // Claude Code usage ("Xenon Pulse") widget. Reads local ~/.claude transcripts;
  // no keys, no network. Only the plan/budget config is persisted here.
  claude: claudeUsage.DEFAULT_CLAUDE,
  // Scrolling ticker bar (news/stocks/football). Bottom edge by default,
  // configurable to the top or hidden. Freezes automatically in game/perf mode.
  ticker: Object.freeze({ enabled: false, position: 'bottom', speed: 50, sources: Object.freeze({ stocks: true, football: true, news: true }) }),
  // Home Assistant Smart Home bridge. url/entities are client-visible; `token`
  // (a long-lived access token) is a server-only secret (preserve-on-save +
  // redact-on-wire). `entities` = the entity_ids the Smart Home tile shows.
  homeAssistant: Object.freeze({ url: '', token: '', entities: [] }),
  // UniFi Protect cameras. host/username/cameras (the selection to display) are
  // client-managed; the console `password` is a server-only secret (redacted on
  // the wire, restored on save). Mirror of settings.js.
  unifi: Object.freeze({ host: '', username: '', password: '', cameras: [], columns: 0, fit: 'cover', aspect: '16:9', order: [], refreshMs: 1500, angles: {}, notify: Object.freeze({ enabled: false, types: Object.freeze({ person: true, vehicle: true, package: false, animal: false, motion: false, ring: true }), cooldownSec: 45 }) }),
  remoteControl: Object.freeze({ enabled: false, sunshineInstalled: false, tailscaleInstalled: false, sunshineUser: '', sunshinePass: '', selectedMonitors: [], selectedScreen: '' }),
  // Paired-device access (the phone as a second screen). OFF by default: while
  // false, remote-access.js is never consulted and a non-loopback request is
  // refused by isAllowedRequest() exactly as it always has been.
  // `https` is the T2 door on top of it: same pairing, same gate, TLS on the
  // Tailscale address. Separate flag because it can fail for reasons that have
  // nothing to do with pairing (no Tailscale, not logged in, certificates not
  // enabled for the tailnet) and because turning it off must not turn off the
  // LAN door people already rely on.
  remoteAccess: Object.freeze({ enabled: false, https: false }),
  // Phone ↔ PC file transfer. Server-owned for the same reason remoteAccess is,
  // plus a sharper one: `inboxDir` is a real folder on THIS PC, and the settings
  // blob is mirrored to every browser surface and into the localStorage of every
  // paired phone. A path that only this machine needs must not travel — the
  // geminiApiKey lesson, applied before the fact rather than after. The only
  // writer is POST /api/transfer/settings, which is loopback-only.
  // Recording options (capture-settings.js). Server-owned like fileTransfer:
  // `folder` is a folder on this PC; the writers are /capture/settings and the
  // recordingOptions capability, through updateCaptureSettings.
  capture: CaptureSettings.DEFAULTS,
  fileTransfer: Object.freeze({
    enabled: true,
    inboxDir: '',        // '' = resolved from the OS on first read (Downloads/Xenon)
    autoDeliver: true,
    maxFileMb: 2048,
    quotaMb: 8192,
    keepDays: 14,
    notifyPhone: false,  // push when the PC puts a file there; never the other way
  }),
});

module.exports = { HUB_DEFAULTS_CONNECTIONS };
