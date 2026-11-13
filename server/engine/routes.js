// What the engine answers about itself: that it is up, and a line a page asks it to log.

const { readBodyBuffer } = require('../http/read-body.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /ping': async (_req, res) => {
    // 1×1 transparent GIF — used by the iCUE widget to probe connectivity via
    // Image() instead of fetch(), bypassing Qt WebEngine's LocalContentCanAccessRemoteUrls block.
    const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(gif);
  },

  'POST /api/log': async (req, res) => {
    try {
      const body = await readBodyBuffer(req, 4 * 1024);
      const { msg } = JSON.parse(body.toString('utf8') || '{}');
      if (typeof msg === 'string') process.stdout.write('[CLIENT] ' + msg + '\n');
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }
  },
};

module.exports = { branches };
