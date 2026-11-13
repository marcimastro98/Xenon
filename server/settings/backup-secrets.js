// Says which services of a configuration need a secret, so a restored backup can list the ones
// to set up again.

const { hasLightingProviderTokens } = require('../lights/secrets.js');

// Which secret-backed services are configured — booleans only. Exported with
// the bundle so the import side can report "these need re-setup" precisely.
function _backupSecretFlags(settings, tokens) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const tok = (name) => { const t = tokens && tokens[name]; return !!(t && (t.refreshToken || t.accessToken)); };
  return {
    gemini: !!s.geminiApiKey,
    openai: !!s.openaiApiKey,
    anthropic: !!s.anthropicApiKey,
    localApi: !!s.localApiKey,
    obs: !!s.obsPassword,
    streamerbot: !!s.streamerbotPassword,
    homeAssistant: !!(s.homeAssistant && s.homeAssistant.token),
    unifi: !!(s.unifi && s.unifi.password),
    sunshine: !!(s.remoteControl && (s.remoteControl.sunshineUser || s.remoteControl.sunshinePass)),
    twelveData: !!s.twelveDataKey,
    finnhub: !!s.finnhubKey,
    sportsDb: !!s.sportsDbKey,
    newsData: !!s.newsDataKey,
    lightingProviders: hasLightingProviderTokens(s),
    spotify: tok('spotify'),
    twitch: tok('twitch'),
    youtube: tok('youtube'),
    discord: tok('discord'),
  };
}

// Services the imported configuration uses whose secrets could NOT travel in
// the backup and are also absent on THIS machine — surfaced to the user after
// the import ("re-connect Spotify, re-enter the TwelveData key, …") instead of
// each feature silently failing later. v1 bundles carry no flags → empty list.
function _backupNeedsSetup(flags, settings, tokens) {
  if (!flags || typeof flags !== 'object') return [];
  const local = _backupSecretFlags(settings, tokens);
  return Object.keys(local).filter((k) => flags[k] === true && !local[k]);
}

module.exports = { _backupSecretFlags, _backupNeedsSetup };
