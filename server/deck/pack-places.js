// Where the Deck's sound clips, sound packs and icon packs are kept, and how big a pack sent
// for install may be.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

// Deck soundboard library: uploaded clips live here under server-generated
// names; the extension set mirrors the /deck/sound streaming allowlist.
const DECK_SOUNDS_DIR = path.join(DATA_DIR, 'sounds');

// Installed Deck icon packs (the 'icons' preset kind): one validated folder per
// pack, written/served only through icon-packs.js (see that module's boundary
// notes). The JSON install body cap covers the 2MB decoded pack in base64.
const ICON_PACKS_DIR = path.join(DATA_DIR, 'icon-packs');
const ICON_PACK_BODY_MAX = 4 * 1024 * 1024;

// Installed soundboard packs (the 'sounds' preset kind): validated folders
// under the sounds library, written only through sound-packs.js. Their clips
// play through the existing /deck/sound reader via pack-relative refs.
const SOUND_PACKS_DIR = path.join(DECK_SOUNDS_DIR, 'packs');
const SOUND_PACK_BODY_MAX = 4 * 1024 * 1024;

module.exports = {
  DECK_SOUNDS_DIR, ICON_PACKS_DIR, ICON_PACK_BODY_MAX, SOUND_PACKS_DIR, SOUND_PACK_BODY_MAX,
};
