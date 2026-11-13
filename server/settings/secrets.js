// Keeps secrets out of the settings sent to a browser, and puts them back when the browser
// saves settings without them.

const CaptureSettings = require('../capture-settings.js');
const { preserveAiProviderCreds, redactAiProviderCreds } = require('../ai-provider-creds.js');
const icsFeeds = require('../ics-feeds.js');
const { preserveHaToken, redactHaToken } = require('../actions/home-assistant.js');
const { preserveRemoteCreds, redactRemoteCreds } = require('../remote-control/settings.js');
const { preserveStreamCreds, redactStreamCreds } = require('../stream-creds.js');
const { preserveUnifiCreds, redactUnifiCreds } = require('../actions/unifi.js');
const { preserveStockCreds, redactStockCreds } = require('../stocks-creds.js');
const { preserveFootballCreds, redactFootballCreds } = require('../football-creds.js');
const { preserveNewsCreds, redactNewsCreds } = require('../news-creds.js');
const { redactTransferPaths, preserveTransferPaths } = require('../transfer/settings-paths.js');
const { redactLightingTokens } = require('../lights/secrets.js');

// ── Settings secrets — one composed helper per direction ─────────────────────
// Every server-only secret must be redacted at EVERY settings→browser exit
// (GET /settings, POST /settings response, backup export) and preserved on
// every settings write path (POST /settings, backup import). These composed
// helpers are the single place a future secret gets added — the stock/football/
// news keys were once wiped on import precisely because one hand-built chain
// missed them.
//
// The credentials tied to a destination (Home Assistant token, UniFi / OBS /
// Streamer.bot passwords) are preserved only while that destination is
// unchanged — see each helper. Otherwise one write that changes only the URL
// (a settings save, or an imported backup) would aim the saved secret at a new
// host.
function redactSettingsSecrets(settings) {
  return icsFeeds.redactCalendarFeedUrls(CaptureSettings.redactCaptureFolder(redactTransferPaths(redactAiProviderCreds(redactLightingTokens(redactUnifiCreds(redactNewsCreds(redactFootballCreds(redactStockCreds(redactStreamCreds(redactHaToken(redactRemoteCreds(settings))))))))))));
}
function preserveSettingsSecrets(incoming, prev) {
  return icsFeeds.preserveCalendarFeedUrls(CaptureSettings.preserveCaptureFolder(preserveTransferPaths(preserveAiProviderCreds(preserveUnifiCreds(preserveNewsCreds(preserveFootballCreds(preserveStockCreds(preserveStreamCreds(preserveHaToken(preserveRemoteCreds(incoming, prev), prev), prev), prev), prev), prev), prev), prev), prev), prev), prev);
}

module.exports = { redactSettingsSecrets, preserveSettingsSecrets };
