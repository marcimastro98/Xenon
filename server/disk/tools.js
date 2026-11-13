// What the assistant does when asked what fills the disks: it only reads.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'disk_insights': async ({ fnArgs }, { diskSpace }) => {
      let fnResult;
      // Read-only by construction: there is no deleteFile action type anywhere
      // (registry, Deck, SDK, AI) — a human tap on the disk widget is the only
      // path to a deletion, and even that goes to the Recycle Bin.
      fnResult = await diskSpace.insights(fnArgs.rootIndex);
      return fnResult;
  },
};

module.exports = { branches };
