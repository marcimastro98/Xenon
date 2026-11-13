// What the engine remembers about OBS and Streamer.bot while it runs: whether a page wants OBS
// watched, and the last things Streamer.bot reported.

const streamingLive = {
  // The OBS widget signals local-OBS intent by successfully probing /obs/scenes: a
  // blank host still connects to 127.0.0.1, so a reachable LOCAL OBS should light up
  // the live watch + preview WITHOUT the user having to type a host. Held true only
  // while a dashboard is open (reset when the last SSE client leaves), so a non-OBS
  // user — who never adds the widget and never hits /obs/scenes — keeps zero OBS
  // sockets. An explicit `obsHost` in settings arms the watch on its own regardless.
  obsWanted: false,
  streamerbotActivity: [],
};

module.exports = { streamingLive };
