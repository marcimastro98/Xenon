'use strict';
// The Xenon Pump widget for iCUE, built from icue-package/ when it is asked for:
// one .icuewidget (a plain zip) in Xenon's temp folder, handed to the program the
// system opens .icuewidget files with, which is iCUE: it shows its own import
// step. Windows only, because iCUE's widgets are. The files are listed here, never
// read from a folder listing, so nothing that lands beside them ships in the zip.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { writeZip } = require('../files/zip-writer.js');
const { openExternalPath } = require('../deck/open-external-path.js');

const PACKAGE_DIR = path.join(__dirname, 'icue-package');
const PACKAGE_FILES = [
  'manifest.json', 'index.html', 'translation.json',
  'scripts/pump.js', 'styles/pump.css', 'resources/icon.png',
];
const FILE_NAME = 'xenon-pump.icuewidget';

/** Writes the .icuewidget into `dir` and answers its path. */
async function buildPackage(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, FILE_NAME);
  await writeZip(out, PACKAGE_FILES.map((name) => ({ name, file: path.join(PACKAGE_DIR, name) })));
  return out;
}

// Whether iCUE's widget import can open on this PC: the one place that says so, read by the
// capability `pumpIcue` (capabilities/index.js), the menu and the opener below.
/** @param {string} [platform] */
const icueImportAvailable = (platform = process.platform) => platform === 'win32';

let opening = null;

/**
 * Builds the widget and opens it with iCUE. Answers { ok } or { ok: false, error }:
 * `unavailable` off Windows, `no_icue` when nothing opens .icuewidget files here.
 * @param {{ platform?: string, dir?: string, open?: (p: string) => Promise<any>, warn?: (msg: string) => void }} [opts]
 *
 * One build at a time: a second tap while iCUE starts gets the first answer.
 */
function openInIcue(opts) {
  if (!opening) opening = openOnce(opts).finally(() => { opening = null; });
  return opening;
}

/** @param {{ platform?: string, dir?: string, open?: (p: string) => Promise<any>, warn?: (msg: string) => void }} [opts] */
async function openOnce({ platform = process.platform, dir = path.join(os.tmpdir(), 'xenon-pump'), open = openExternalPath, warn = (_msg) => {} } = {}) {
  if (!icueImportAvailable(platform)) return { ok: false, error: 'unavailable' };
  let file;
  try { file = await buildPackage(dir); }
  catch (e) {
    warn(`pump screens: the iCUE widget could not be built (${e.code || e.message})`);
    return { ok: false, error: 'build_failed' };
  }
  try {
    const r = await open(file);
    return r && r.ok === false ? { ok: false, error: 'no_icue' } : { ok: true };
  } catch (e) {
    warn(`pump screens: iCUE did not open the widget (${e.message})`);
    return { ok: false, error: 'no_icue' };
  }
}

module.exports = { openInIcue, buildPackage, icueImportAvailable, PACKAGE_DIR, PACKAGE_FILES, FILE_NAME };
