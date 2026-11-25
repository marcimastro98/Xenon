// What the engine answers about the screens of the PC: the same listing the captures use, so a
// screen's bounds here are the ones a capture takes.

const { listScreens } = require('./list-screens.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /api/screens': async (_req, _res, { json }) => {
    json({ screens: await listScreens() });
  },
};

module.exports = { branches };
