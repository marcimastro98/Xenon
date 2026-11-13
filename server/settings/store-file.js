// Facts about the settings file on disk: the shape of its identity, and the read errors that
// only mean "busy, try again".

// Identity of this settings STORE — a random value minted the first time
// settings.json is written and never again (the keep-prev guard in POST
// /settings is what makes "never again" true). It is not an install id and has
// nothing to do with supporter-redeem.js's: it identifies the FILE, so deleting
// server/data mints a new one, which is exactly the "start clean" signal.
//
// Why it exists: every surface mirrors the settings blob into its browser's
// localStorage, keyed by origin, and the boot hydrate resolves a conflict by
// comparing `rev`. But `rev` counts up from 0 per store, so a store that was
// just created loses to ANY surface that still holds an older mirror of the
// same origin. Measured on Discord: a user reinstalled Windows and Xenon, the
// PC's LAN address came back the same, and the phone paired before the wipe
// re-published its months-old layout over the fresh install — pleasant that
// time, but the symmetric case is a freshly configured dashboard overwritten by
// a mirror nobody meant to restore. Comparing the store id turns "higher rev"
// into "higher rev in the SAME store"; a mirror from another store is not newer,
// it is somebody else's. The client half is in js/settings.js.
const SETTINGS_STORE_ID_RE = /^[0-9a-f]{32}$/;

// Windows can refuse a read for a moment while another program (an antivirus
// scan, the search indexer, a second Xenon) holds the file. That is not damage,
// so it is retried briefly before it counts as a failure.
const _SETTINGS_READ_BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

module.exports = { SETTINGS_STORE_ID_RE, _SETTINGS_READ_BUSY };
