// How many recent Streamer.bot events are kept for the widget's feed.

// Recent Streamer.bot activity (follows/subs/raids/cheers/redemptions…) for the
// Streamer.bot widget's live feed — a bounded ring buffer so it can't grow. Each
// new event is pushed live over the `streamerbot_event` SSE event AND kept here so
// a just-added tile seeds its feed from GET /streamerbot/activity. (Phase 3.)
const SB_ACTIVITY_MAX = 40;

module.exports = { SB_ACTIVITY_MAX };
