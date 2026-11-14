'use strict';
// Picks a provider's model: what a stored choice means, one cleaned entry of a provider's model
// list, and the newest model of a family.

const SENTINEL_RE = /^auto(?::([a-z0-9.-]{1,24}))?$/;

// Re-validate a persisted entry key by key: the file on disk could predate a
// schema change, and it is external input to this process like any other.
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = typeof e.id === 'string' ? e.id.trim() : '';
  if (!id || id.length > 80 || !/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) return null;
  const kind = typeof e.kind === 'string' ? e.kind.slice(0, 16) : '';
  if (!kind) return null;
  const rank = Number.isFinite(e.rank) ? Number(e.rank) : null;
  return {
    id,
    label: typeof e.label === 'string' && e.label ? e.label.slice(0, 80) : id,
    kind,
    family: typeof e.family === 'string' ? e.family.slice(0, 24) : '',
    rank,
    preview: e.preview === true,
    alias: e.alias === true,
  };
}

// Parse a stored value. { auto:false } means it is a pin and must be used as-is.
//
// The sentinel is matched case-folded, and this is the site that explains why for
// all five copies of the rule (the three sanitizeModel functions, the client's
// normalizeModelChoice, and here). `auto` is a keyword this app defines, but the
// id pattern the sentinel falls through to is case-INSENSITIVE, so `AUTO` typed
// into the Custom… field looked like a perfectly good model id and was stored as
// a deliberate pin. Nothing repairs that: no provider has a model called AUTO, so
// every request 404s, and markMissing() only drops entries from the cached list,
// where an id nobody published never appeared. The setting reads as configured
// while every turn silently pays a failed request.
//
// The family is captured from the FOLDED string on purpose — `auto:SONNET` must
// produce `sonnet`, or it would be compared against the lowercase `e.family` in
// pickLatest and match nothing. The id keeps its original case: an unrecognised
// value is a pin, and a pin is the provider's string, not ours.
function parseStored(stored) {
  const v = String(stored || '').trim();
  const m = SENTINEL_RE.exec(v.toLowerCase());
  if (!m) return { auto: false, family: '', id: v };
  return { auto: true, family: m[1] || '', id: '' };
}

// The newest model of `family` that can fill `kind`. Highest rank wins; on a tie
// a stable id beats a preview. Aliases and unranked entries are never chosen —
// they are pins the user can select by hand, not something `auto` should land on
// (an id the Settings panel cannot explain is a setting that explains nothing).
function pickLatest(entries, kind, family, providerMod) {
  const usable = providerMod && typeof providerMod.usableForKind === 'function'
    ? providerMod.usableForKind
    : (e, k) => e.kind === k;
  const candidates = (Array.isArray(entries) ? entries : []).filter(e =>
    e && !e.alias && Number.isFinite(e.rank) && usable(e, kind)
    && (!family || e.family === family));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.rank - a.rank) || ((a.preview ? 1 : 0) - (b.preview ? 1 : 0)));
  return candidates[0].id;
}

module.exports = { SENTINEL_RE, normalizeEntry, parseStored, pickLatest };
