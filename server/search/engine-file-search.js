// The engine's search of the person's files and apps.

const { revealInFileManager } = require('../files/reveal-in-file-manager.js');
const { getInstalledApps } = require('./installed-apps-list.js');
const { createFileSearch } = require('../filesearch.js');
const { createMdfindRunner } = require('./mdfind.js');
const { DATA_DIR } = require('../engine/paths.js');
const { livingIndex } = require('./living-index-engine.js');
const { openExternalPath } = require('../deck/open-external-path.js');
const { launchInstalledApp } = require('./launch-installed-app.js');

const fileSearch = createFileSearch({
  dataDir: DATA_DIR,
  livingIndex,
  openExternal: (p, args) => openExternalPath(p, args),
  // Injected rather than kept as a second copy of the platform switch: the
  // transfer widget's "show in folder" is the same verb, and two copies of a
  // three-way platform branch drift into one of them working off Windows.
  revealExternal: (p, dir) => revealInFileManager(p, dir),
  appsProvider: getInstalledApps,
  launchApp: launchInstalledApp,
  catalogRunner: process.platform === 'darwin' ? createMdfindRunner() : undefined,
});

module.exports = { fileSearch };
