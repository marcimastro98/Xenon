// What the assistant does when asked to play, pause or skip what is playing, or to play
// something in a tile of the dashboard.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const { offerControl } = require('../ai/reply-control-offer.js');

// The music control under Bit's reply, once the PC took the key.
function offerMedia(clientActions, fnResult) {
  if (!(fnResult && (fnResult.error || fnResult.ok === false))) offerControl(clientActions, { kind: 'media' });
  return fnResult;
}

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'media_playpause': async ({ clientActions }, { mediaAction }) => {
      let fnResult;
      fnResult = offerMedia(clientActions, await mediaAction('playpause'));
      return fnResult;
  },

  'media_next': async ({ clientActions }, { mediaAction }) => {
      let fnResult;
      fnResult = offerMedia(clientActions, await mediaAction('next'));
      return fnResult;
  },

  'media_previous': async ({ clientActions }, { mediaAction }) => {
      let fnResult;
      fnResult = offerMedia(clientActions, await mediaAction('previous'));
      return fnResult;
  },

  'play_in_tile': async ({ fnArgs }, { playInTile }) => {
      let fnResult;
      fnResult = await playInTile(fnArgs);
      return fnResult;
  },
};

module.exports = { branches };
