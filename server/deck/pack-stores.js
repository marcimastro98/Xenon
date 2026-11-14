// The stores of the icon packs and sound packs the person installed for the Deck, made when the
// engine starts: each reads its folder when asked.

const iconPacks = require('../icon-packs.js');
const soundPacks = require('../sound-packs.js');
const { ICON_PACKS_DIR, SOUND_PACKS_DIR } = require('./pack-places.js');

const iconPackStore = iconPacks.createIconPacks({ dir: ICON_PACKS_DIR });
const soundPackStore = soundPacks.createSoundPacks({ dir: SOUND_PACKS_DIR });

module.exports = { iconPackStore, soundPackStore };
