// What the assistant does when asked to remember something about the user, or to forget it: the
// facts stay on this PC.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'remember_fact': async ({ fnArgs }, { aiMemory }) => {
      let fnResult;
      // Persistent memory: store a durable fact about the user (local only).
      fnResult = await aiMemory.add(fnArgs.fact || fnArgs.text || '');
      return fnResult;
  },

  'forget_fact': async ({ fnArgs }, { aiMemory }) => {
      let fnResult;
      fnResult = await aiMemory.remove(fnArgs.fact || fnArgs.text || fnArgs.query || '');
      return fnResult;
  },
};

module.exports = { branches };
