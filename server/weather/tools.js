// What the assistant does when asked about the weather.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'get_weather': async ({ uiLang }, { getWeather }) => {
      let fnResult;
      fnResult = await getWeather(uiLang, null);
      return fnResult;
  },
};

module.exports = { branches };
