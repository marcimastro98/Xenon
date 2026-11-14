// What the engine answers about itself: that it is up, and a line a page asks it to log.

const { readBodyBuffer } = require('../http/read-body.js');
const UsageMode = require('../js/usage-mode.js');
const { hub } = require('../settings/current.js');
const LayersModel = require('../js/layers-model.js');
const fs = require('node:fs');
const path = require('node:path');
const LayerPage = require('../layer-page.js');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
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

  'GET /': async (req, res, { isRemote, remote, sendPage }) => {
    // A layer window on THIS machine whose surface holds Store widgets and tiles
    // the light page can carry gets that page (~130 MB less per window), with
    // those tiles' files added; any other built-in tile needs the whole
    // dashboard. js/layers-model.js owns the rule, and the page reloads by the
    // same one when the user adds or removes a tile there.
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    // "Widgets only" (js/usage-mode.js): the app's own window (`shell=main`, set
    // by the splash) gets the small driver page instead of the dashboard, and the
    // shell hides the window when it sees that URL load. `full=1` is the tray's
    // "Show Xenon": the user asked for the dashboard this once.
    if (!isRemote && query.get('shell') === 'main' && query.get('full') !== '1'
        && UsageMode.widgetsOnly(hub.settings.usageMode)) {
      res.writeHead(302, { Location: '/shell-driver', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const layerKey = query.get('layer');
    if (!isRemote && LayersModel.isSurfaceKey(layerKey) && !LayersModel.needsDashboard(hub.settings.layers, layerKey)) {
      const lite = await fs.promises.readFile(path.join(SERVER_DIR, 'layer-lite.html'), 'utf8');
      const tiles = LayersModel.liteTilesFor(hub.settings.layers, layerKey);
      const dashboard = LayerPage.needsDashboardHtml(tiles) ? await fs.promises.readFile(path.join(SERVER_DIR, 'index.html'), 'utf8') : '';
      await sendPage(LayerPage.compose(lite, tiles, dashboard));
      return;
    }
    let html = await fs.promises.readFile(path.join(SERVER_DIR, 'index.html'), 'utf8');
    // A paired device is told so SYNCHRONOUSLY, in the document itself, before
    // any script runs — a flag arriving later over /status would be too late for
    // anything that decides at load time. It carries no privileges: the client
    // reads it only to know which chrome it is wearing and to explain a refusal.
    // `assetKey` rides along because it is needed at the same moment and by the
    // same reasoning: custom-widget.js builds an SDK iframe's src at mount time
    // and the sandboxed document it loads cannot present a cookie for its own
    // stylesheet and script (see remote-access.js). It is a capability for the
    // widget asset tree and nothing else.
    //
    // `inlineJson`, not bare JSON.stringify: inside a <script> element the
    // parser looks for `</script` before it looks for anything JavaScript, and
    // JSON.stringify escapes neither `<` nor `/`. The device name is chosen by
    // whoever redeems the pairing code and is only length-clamped, so a name of
    // `</script>…` closes the element early. Today that is self-inflicted — this
    // document is served only to the device whose token produced the name — but
    // "the sink is currently harmless" is not a property that survives someone
    // adding a third field or reusing the marker somewhere else. Escaped at the
    // sink, which is the only place that stays true. U+2028/2029 go too: they
    // are line terminators to a JS parser and not to JSON.
    if (isRemote) {
      const inlineJson = (v) => JSON.stringify(v == null ? '' : v)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      html = html.replace('<meta charset="UTF-8">',
        '<meta charset="UTF-8">\n<script>window.__xenonRemote = { device: ' +
        inlineJson(remote.device && remote.device.name) + ', assetKey: ' +
        inlineJson(remote.device && remote.device.assetKey) + ' };</script>');
    }
    // Never let the WebView serve a stale entry document: index.html carries the
    // early boot-scale recovery script, so a cached copy would pin an old fix.
    // The doc is tiny and loopback-served, so no-store costs nothing, and it is
    // what makes the versioned CSS/JS URLs in it safe to keep.
    await sendPage(html);
  },

  'GET /status': async (_req, _res, { json, jsonpCb }, { statusPayload }) => {
    // Any site can read a ?cb= answer, so it says Xenon is on and nothing else:
    // the full status names the game and the app in front. The plain GET and
    // the SSE broadcast keep it (loopback/Origin-guarded).
    json(jsonpCb ? { ok: true } : statusPayload());
  },

  'GET /sse': async (req, res, { isRemote, remote }, { openSseClient }) => {
    // Server-Sent Events stream — replaces client-side polling for status, media,
    // system and audio data. Keepalive pings prevent proxy connection timeouts.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    openSseClient(req, res, isRemote, remote);
  },
};

module.exports = { branches };
