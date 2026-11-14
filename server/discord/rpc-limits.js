'use strict';
// The limits of the Discord link: how long an idle socket is kept, how long a command and the
// Authorize click may take, which channels are voice channels, the audio switches that can be
// toggled, and how many per-person volumes are remembered.

const IDLE_MS = 60000;          // idle-close the authed socket after a minute
const CMD_TIMEOUT_MS = 8000;
const AUTHORIZE_TIMEOUT_MS = 120000;   // the user has to click "Authorize" in Discord
const GUILD_VOICE = 2;          // channel.type for a normal voice channel
const AUDIO_FEATURES = new Set(['noise_suppression', 'echo_cancellation', 'automatic_gain_control', 'qos']);

// How many per-user overrides we track for the socket hold below. Naturally
// bounded by a voice channel's size; capped anyway so nothing here can grow
// without limit.
const MAX_USER_OVERRIDES = 200;

module.exports = {
  IDLE_MS, CMD_TIMEOUT_MS, AUTHORIZE_TIMEOUT_MS, GUILD_VOICE, AUDIO_FEATURES, MAX_USER_OVERRIDES,
};
