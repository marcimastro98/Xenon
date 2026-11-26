'use strict';
// The Bit kit: the Bit engine (shared/src/bit-*.js, the same files the dashboard loads)
// and its small API for widgets (js/bit-companion/kit-api.js) in one file. A widget's frame
// runs only scripts of its own package, so a widget that draws the person's own Bit copies
// this file in: widget_template { bit: true } of the MCP tools writes it, and the site's
// copy (docs/create/bit-kit.js, tools/bit-kit.mjs) is the same text.

const fsp = require('fs/promises');
const path = require('path');

const SERVER = path.join(__dirname, '..');
// The engine in the order the dashboard loads it (test/fixtures/bit-engine.json), up to the player.
const ENGINE = Object.freeze([
  'shared/src/bit-clips.js', 'shared/src/bit-color.js', 'shared/src/bit-genes.js', 'shared/src/bit-genome.js',
  'shared/src/bit-look.js', 'shared/src/bit-wardrobe.js', 'shared/src/bit.js', 'shared/src/bit-clips-life.js',
  'shared/src/bit-director.js', 'shared/src/bit-player.js',
]);
// Then the signs over its head (no engine file needs them) and the API.
const FILES = Object.freeze([...ENGINE, 'shared/src/bit-signs.js', 'js/bit-companion/kit-api.js']);

const HEAD = '// Bit kit for Xenon widgets: the Bit engine and XenonBit.mount(host).set(bitStreamData).\n'
  + '// Copy it into your widget package and load it before your own script. See docs/WIDGET_SDK.md, "Your own Bit".\n';

let built = null;

/** The kit's text, read once from the files the app ships. */
function bitKit() {
  if (!built) {
    built = Promise.all(FILES.map((f) => fsp.readFile(path.join(SERVER, f), 'utf8')))
      .then((parts) => HEAD + parts.map((text, i) => `\n// ---- ${path.basename(FILES[i])}\n${text}`).join(''))
      .catch((e) => { built = null; throw e; });
  }
  return built;
}

module.exports = { bitKit, FILES, ENGINE };
