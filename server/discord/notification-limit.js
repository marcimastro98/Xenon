// How many recent Discord notifications are kept for the widget's feed.

// Recent Discord notifications for the widget's feed — a bounded ring buffer,
// mirroring the Streamer.bot activity feed. Each item is already projected to a
// client-safe shape by the provider (title/body text + https-only icon); it's
// pushed live over the `discord_notification` SSE event AND kept here so a
// just-added tile seeds from GET /stream/discord/notifications. Cleared on
// logout and when the feature is toggled off — never grows past the cap.
const DISCORD_NOTIF_MAX = 30;

module.exports = { DISCORD_NOTIF_MAX };
