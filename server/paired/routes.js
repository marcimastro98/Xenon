// What the engine answers when a phone asks to install the dashboard as an app.

const { APP_VERSION } = require('../updates/app-version.js');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /manifest.webmanifest': async (_req, res) => {
    // The web app manifest. Built here rather than kept as a static file so the
    // version travels with it and the icon paths cannot drift from the assets.
    //
    // NOTE for whoever changes the <link> tag: a same-origin manifest is fetched
    // with credentials OMITTED unless the tag says `crossorigin="use-credentials"`.
    // Without that the pairing cookie is withheld, the fetch comes back 401, and
    // the only symptom is that the browser silently refuses to offer "install" —
    // the same shape as the widget-asset bug, and just as invisible.
    const icon = '/public/images/logo/logo-mark.png';
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      name: 'Xenon',
      short_name: 'Xenon',
      description: 'Your PC, on the screen next to it.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#070808',
      theme_color: '#070808',
      version: APP_VERSION,
      icons: [
        // One square mark is what exists as a shipped asset; its size is declared
        // honestly rather than claimed at 512. Installability needs >=192, which
        // this meets — a dedicated 512 maskable icon would buy a better splash
        // screen and is a design asset, not a code change.
        { src: icon, sizes: '256x256', type: 'image/png', purpose: 'any' },
        { src: icon, sizes: '256x256', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  },

  'GET /pair': async (_req, res) => {
    // The pairing page — the ONE document reachable before a device has a
    // token. Deliberately self-contained (no dashboard scripts, no settings, no
    // state) so the pre-auth surface stays as small as it reads.
    const html = await fs.promises.readFile(path.join(SERVER_DIR, 'pair.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  },

  'GET /sw.js': async (_req, res, { err500 }) => {
    // The service worker, served from the ROOT on purpose: a worker's default
    // scope is its own directory, so one under /public/ could only control
    // /public/. The version is stamped in here rather than read by the worker,
    // which is what makes a Xenon update drop the previous shell cache whole.
    try {
      const src = await fs.promises.readFile(path.join(SERVER_DIR, 'sw.js'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        // Never cached by the browser: this file decides what everything else
        // caches, so a stale copy of it is the one that cannot be recovered from.
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/',
      });
      res.end(src.replace('__XENON_VERSION__', APP_VERSION));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
