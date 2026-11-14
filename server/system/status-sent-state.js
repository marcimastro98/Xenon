// The status last sent to the dashboards and when.

const statusSent = {
  // Broadcast only when the payload actually changed (plus a slow heartbeat).
  // The payload is identical tick after tick on an idle PC, and every SSE event
  // wakes each connected renderer (parse + handlers + DOM writes + a composited
  // frame) — a constant idle CPU/GPU tax users see on a dashboard nobody is
  // touching. Lighting and the briefing sampler still see every 3s tick; only
  // the wire broadcast is deduplicated. The 30s heartbeat keeps slow consumers
  // honest — notably the version-fence reload deferred while the user is typing
  // (main.js retries it on each status event).
  json: '',
  at: 0,
};

module.exports = { statusSent };
