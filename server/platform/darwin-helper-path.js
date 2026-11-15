'use strict';
// Where the macOS helper program is.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

// --- the native helper: the same three numbers, with nothing to install -----
// `xenon-helper temps` reads GPU load from IOKit's public accelerator registry
// and the temperatures from the HID sensor services. It is preferred over
// macmon when it answers, and macmon stays as the fallback for the machines it
// cannot read (an Intel Mac exposes neither sensor family under those names).
// Both paths are optional and both degrade to null, which is what the tiles
// already render as "--".
const HELPER_EXE = path.join(SERVER_DIR, 'helper', 'xenon-helper');

module.exports = { HELPER_EXE };
