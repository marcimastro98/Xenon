'use strict';
// Cleans single values of the football data: an id, the API key, a number, a picture address, a
// colour, a season, the state of a match.

const FREE_KEY = '123';            // public keyless test key

// TheSportsDB ids are numeric strings. Anything else is dropped — these are
// interpolated into the provider URL.
function cleanId(value) {
  const s = String(value == null ? '' : value).trim();
  return /^[0-9]{1,12}$/.test(s) ? s : '';
}
// A Premium key is alphanumeric; fall back to the public key on anything odd so
// a malformed key can never break the URL path.
function cleanKey(value) {
  const s = String(value || '').trim();
  return /^[A-Za-z0-9]{1,40}$/.test(s) ? s : FREE_KEY;
}
function apiBase(key) { return `https://www.thesportsdb.com/api/v1/json/${cleanKey(key)}/`; }

function str(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 80); }
function intOrNull(value) {
  if (value == null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
// A badge/crest URL is rendered as an <img src>; only allow https on the
// provider's own image host (scheme + host allowlist — see CLAUDE.md invariant).
function safeImg(value) {
  const s = String(value || '').trim().slice(0, 300);
  if (!/^https:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    return /(^|\.)thesportsdb\.com$/i.test(u.hostname) ? s : '';
  } catch { return ''; }
}
// A club colour is written into a CSS custom property, so it is validated as a
// literal hex triplet rather than trusted: anything else returns '' and the UI
// falls back to the theme accent. (TheSportsDB stores these free-form.)
function safeColour(value) {
  const s = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
}
function cleanSeason(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{4}$/.test(s) ? s : '';
}

// Map TheSportsDB's strStatus into three buckets the UI cares about.
function statusClass(strStatus, strPostponed) {
  if (String(strPostponed || '').toLowerCase() === 'yes') return 'pp';
  const s = String(strStatus || '').trim().toUpperCase();
  if (!s || s === 'NS' || s === 'NOT STARTED' || s === 'TBD' || s === 'TBA') return 'ns';
  if (['FT', 'AET', 'PEN', 'FT_PEN', 'MATCH FINISHED', 'AWARDED', 'WO'].includes(s)) return 'ft';
  if (['PP', 'POSTP', 'POSTPONED', 'CANC', 'CANCELLED', 'ABD', 'ABANDONED', 'SUSP'].includes(s)) return 'pp';
  return 'live'; // 1H, 2H, HT, ET, BT, P, LIVE, or a minute number
}

module.exports = {
  FREE_KEY, cleanId, cleanKey, apiBase, str, intOrNull, safeImg, safeColour, cleanSeason,
  statusClass,
};
