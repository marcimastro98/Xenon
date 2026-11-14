// Loaded before the engine in a throwaway copy (`node --require`): writes down every file of the copy the moment
// Node starts loading it for the first time, in order, and a line when the engine file itself has finished loading.
// load-order.mjs compares two such lists.
'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const out = process.env.XENON_LOAD_ORDER;
const root = process.cwd();
const load = Module._extensions['.js'];
const ENGINE = 'server/server.js';
const DONE = '# the engine file has loaded';

if (out) {
  Module._extensions['.js'] = function logged(module, filename) {
    const name = path.relative(root, filename).split(path.sep).join('/');
    fs.appendFileSync(out, `${name}\n`);
    const result = load.call(this, module, filename);
    if (name === ENGINE) fs.appendFileSync(out, `${DONE}\n`);
    return result;
  };
}

module.exports = { DONE };
