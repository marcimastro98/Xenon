// Starts an app the search found among the installed apps, the way each system starts one.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { launchLinuxApp } = require('../programs/launch-linux-app.js');
const { openExternalPath } = require('../deck/open-external-path.js');

async function launchInstalledApp(app) {
  // Both POSIX kinds come from installed-apps.js's own enumeration (the search
  // resolves an opaque id back to it), re-checked to exist before the launch.
  if (app.kind === 'macapp') {
    if (!/\.app$/.test(app.target)) throw new Error('bad_app');
    await fs.promises.stat(app.target);
    await new Promise((resolve, reject) => {
      execFile('open', [app.target], { timeout: 8000 }, (e) => (e ? reject(e) : resolve()));
    });
    return;
  }
  if (app.kind === 'desktop') {
    if (!/\.desktop$/.test(app.target)) throw new Error('bad_app');
    await fs.promises.stat(app.target);
    await launchLinuxApp(app.target);
    return;
  }
  if (app.kind === 'store') {
    if (!/^[\w.-]+![\w.-]+$/.test(app.target)) throw new Error('bad_aumid');
    await new Promise((resolve, reject) => {
      // argv array, no shell — the AUMID lands as one discrete argument.
      execFile('explorer.exe', ['shell:AppsFolder\\' + app.target], { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
    });
    return;
  }
  // Start-Menu shortcut: server-enumerated, so this IS the app's launcher —
  // opened by the same system handler every Deck key uses.
  await fs.promises.stat(app.target);
  await openExternalPath(app.target);
}

module.exports = { launchInstalledApp };
