// Lists the apps installed on Windows, from the Start menu and from the Store, and says how
// long the list is reused.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readStartApps } = require('../notification-open/start-apps.js');

const INSTALLED_APPS_TTL_MS = 15 * 60 * 1000;

async function _enumStartMenuLnks() {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
  ];
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 400) {
      const dir = stack.pop();
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile() && /\.lnk$/i.test(ent.name)) {
          const name = ent.name.replace(/\.lnk$/i, '');
          // Uninstallers and doc links masquerade as apps — drop the obvious ones.
          if (/uninstall|disinstalla|readme|website|web site|documentation|user manual|release notes/i.test(name)) continue;
          out.push({ name, kind: 'lnk', target: full });
        }
      }
    }
  }
  return out;
}

function _enumStoreApps() {
  // Packaged apps only, by the same strict AUMID shape the Deck's storeapp action validates.
  return readStartApps(execFile).then((apps) => apps.filter((a) => /^[\w.-]+![\w.-]+$/.test(a.id))
    .map((a) => ({ name: a.name, kind: 'store', target: a.id })));
}

module.exports = { INSTALLED_APPS_TTL_MS, _enumStartMenuLnks, _enumStoreApps };
