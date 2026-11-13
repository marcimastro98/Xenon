// What the engine answers about drawing over the screen: whether the drawing sheet is open.

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /screen-draw': async (_req, _res, { json }, { drawShell }) => {
    // Whether the drawing sheet is open (screen-draw-shell.js), for a page that
    // (re)connects; changes arrive over SSE `screen_draw`. Read-only.
    json({ drawing: drawShell.get() });
  },
};

module.exports = { branches };
