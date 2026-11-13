// The accounts the streaming pages talk to (Twitch, YouTube, Spotify), made again when the user
// saves new app keys.

const streams = {
  twitch: undefined, // given its first value where the engine loads
  youtube: undefined, // given its first value where the engine loads
  spotify: undefined, // given its first value where the engine loads
};

module.exports = { streams };
