// What the engine answers when a phone asks to install the dashboard as an app.

const { APP_VERSION } = require('../updates/app-version.js');

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
};

module.exports = { branches };
