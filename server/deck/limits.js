// Limits of the Deck: the size of its saved configuration and of a sound, and the sound files
// it accepts.

const DECK_SOUND_MAX_BYTES = 15 * 1024 * 1024;
const DECK_SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba']);
const DECK_SOUND_NAME_RE = /^sound-[0-9]+-[0-9a-f]+\.[a-z0-9]+$/;

// Deck configs hold image-icon data URLs (up to ~1.5 MB each), so the store can
// run to several MB across many keys; cap generously to bound disk use.
const DECK_MAX_BYTES = 8 * 1024 * 1024;

module.exports = { DECK_SOUND_MAX_BYTES, DECK_SOUND_EXTS, DECK_SOUND_NAME_RE, DECK_MAX_BYTES };
