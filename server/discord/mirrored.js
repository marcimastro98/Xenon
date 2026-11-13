// The Discord messages mirrored so far, and whether Discord is linked and so can answer a call.

const discordMirror = {
  notifications: [],
  // Whether Discord can actually answer. Kept as a flag rather than an async
  // status() call because capabilities are computed while a call is ringing, and
  // a card that takes a round trip to decide whether to draw its main button is a
  // card that draws it late. refreshDiscordWatch keeps it current.
  linkedForCalls: false,
};

module.exports = { discordMirror };
