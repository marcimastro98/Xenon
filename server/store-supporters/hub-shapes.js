// The shapes the redeem proxy accepts before it asks the hub: a code in its canonical form, an
// entry id, a key version and a version number.

const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
// Same canonical form as preset-share: uppercase, [A-Z0-9] only. Hub codes
// canonicalize to a 2-letter prefix + 12 symbols: 'XS' (supporter pass), 'XL'
// (per-entry item code for limited/purchased drops) or 'XT' (the 7-day pass
// trial, see trial-pass.js).
const canonCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const HUB_CODE_RE = /^X[SLT][A-Z0-9]{12}$/;
const TRIAL_RE = /^XT[A-Z0-9]{12}$/;

const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;
// A key version names which of the entry's keys a file was sealed with (see the
// hub's versions.js). Small positive integer or nothing.
const cleanKv = (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null);

module.exports = { ENTRY_ID_RE, canonCode, HUB_CODE_RE, TRIAL_RE, VERSION_RE, cleanKv };
