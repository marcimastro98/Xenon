'use strict';

// The parts of server/whatsnew.json that say what each sheet and each release
// looks like. Rebuilt from known keys only, like normalizeWhatsNew in server.js:
// the file ships with the build, but what reaches the page is still a boundary.

const SHEET_COLORS = Object.freeze(['green', 'lavender', 'yellow', 'blue', 'orange']);
const SHEET_SCENES = Object.freeze(['menu', 'capture', 'fps', 'bit']);
const MENU_SECTIONS = Object.freeze(['now', 'widgets', 'capture', 'keys', 'look', 'mode']);
// Where a sheet's button leads: never an address from the file.
const SHEET_GO = Object.freeze(['sparks', 'supporters', 'maker', 'look']);
const CLIP_ID = /^[a-zA-Z]{1,32}$/;
// What ships with the app, served by the static route (server/assets/whatsnew).
const LOCAL_MEDIA = /^\/assets\/whatsnew\/[a-z0-9-]+\.(webp|png|jpg|mp4)$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_RELEASES = 40;
const MAX_ROWS = 20;

const oneOf = (list, value) => (list.includes(value) ? value : '');

// What a highlight adds to its title and body: the sheet it is drawn on.
function normalizeSheet(h) {
  const src = h && typeof h === 'object' ? h : {};
  return {
    color: oneOf(SHEET_COLORS, src.color),
    clip: typeof src.clip === 'string' && CLIP_ID.test(src.clip) ? src.clip : '',
    scene: oneOf(SHEET_SCENES, src.scene),
    section: oneOf(MENU_SECTIONS, src.section),
    go: oneOf(SHEET_GO, src.go),
  };
}

const isLocalMedia = (v) => typeof v === 'string' && LOCAL_MEDIA.test(v);

// The picture or clip of a sheet: a local file says what it is by its name, an
// address the caller allows (isAllowedUrl) by mediaType. A poster is the still of
// a video, always local: it has to show with no network and no video decoder.
function normalizeMedia(h, isAllowedUrl) {
  const src = h && typeof h === 'object' ? h : {};
  const local = isLocalMedia(src.media);
  if (!local && !(typeof src.media === 'string' && isAllowedUrl(src.media))) return { media: '', mediaType: '', poster: '' };
  const named = String(src.mediaType || '').toLowerCase() === 'video' ? 'video' : 'image';
  const mediaType = local ? (src.media.endsWith('.mp4') ? 'video' : 'image') : named;
  const poster = isLocalMedia(src.poster) && !src.poster.endsWith('.mp4') ? src.poster : '';
  return { media: src.media, mediaType, poster };
}

// The closing sheet: the smaller things of a major, as a list.
function normalizeMore(raw, text) {
  if (!raw || typeof raw !== 'object') return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_ROWS).map(text).filter(Boolean);
  return items.length ? { title: text(raw.title), items, note: text(raw.note) } : null;
}

function normalizeRelease(raw, text) {
  if (!raw || typeof raw !== 'object' || !VERSION.test(String(raw.version || ''))) return null;
  const fixes = (Array.isArray(raw.fixes) ? raw.fixes : []).slice(0, MAX_ROWS)
    .map((f) => ({ area: text(f && f.area), text: text(f && f.text) }))
    .filter((f) => f.area && f.text);
  const news = (Array.isArray(raw.news) ? raw.news : []).slice(0, MAX_ROWS)
    .map((n) => ({ title: text(n && n.title), text: text(n && n.text) }))
    .filter((n) => n.title);
  return fixes.length || news.length ? { version: raw.version, news, fixes } : null;
}

function normalizeReleases(raw, text) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_RELEASES).map((r) => normalizeRelease(r, text)).filter(Boolean);
}

// POST /update/notice-seen: what a surface says the person has read. Anything
// else in the body is dropped, and an empty result writes nothing.
function cleanSeen(body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  if (typeof src.whatsNew === 'string' && src.whatsNew.trim()) out.whatsNewSeen = src.whatsNew.trim().slice(0, 64);
  if (typeof src.notes === 'string' && VERSION.test(src.notes)) out.releaseNotesSeen = src.notes;
  if ((typeof src.failedAt === 'string' || typeof src.failedAt === 'number') && String(src.failedAt)) {
    out.updateFailSeen = String(src.failedAt).slice(0, 64);
  }
  return out;
}

module.exports = {
  normalizeSheet, normalizeMedia, normalizeMore, normalizeReleases, cleanSeen,
  SHEET_COLORS, SHEET_SCENES,
};
