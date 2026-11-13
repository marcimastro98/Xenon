// Checks the "What's New" text of a release before a dashboard shows it.

const { isAllowedMediaUrl } = require('./release-media.js');
const releaseNotes = require('../release-notes.js');

const WHATSNEW_TEXT_MAX = 2000;

function normalizeWhatsNewText(v) {
  if (typeof v === 'string') return v.slice(0, WHATSNEW_TEXT_MAX);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = {};
    for (const [k, s] of Object.entries(v)) {
      if (/^[a-z]{2}$/i.test(k) && typeof s === 'string') out[k.toLowerCase()] = s.slice(0, WHATSNEW_TEXT_MAX);
    }
    return Object.keys(out).length ? out : '';
  }
  return '';
}

// Rebuild from known keys only (never spread untrusted input — prototype-pollution
// safe, and drops anything unrecognised like the "_note" author comment).
function normalizeWhatsNew(raw) {
  if (!raw || typeof raw !== 'object') return { id: '', title: '', url: '', highlights: [] };
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : []).slice(0, 20).map((h) => ({
    title: normalizeWhatsNewText(h && h.title),
    body: normalizeWhatsNewText(h && h.body),
    ...releaseNotes.normalizeMedia(h, isAllowedMediaUrl),
    ...releaseNotes.normalizeSheet(h),
  })).filter((h) => h.title || h.body || h.media);
  return {
    id: String(raw.id || '').slice(0, 64),
    title: normalizeWhatsNewText(raw.title),
    url: (typeof raw.url === 'string' && /^https:\/\//i.test(raw.url)) ? raw.url : '',
    intro: normalizeWhatsNewText(raw.intro),
    highlights,
    more: releaseNotes.normalizeMore(raw.more, normalizeWhatsNewText),
    releases: releaseNotes.normalizeReleases(raw.releases, normalizeWhatsNewText),
  };
}

module.exports = { WHATSNEW_TEXT_MAX, normalizeWhatsNewText, normalizeWhatsNew };
