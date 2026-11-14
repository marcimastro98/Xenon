'use strict';
// Cleans one message Bit is asked to show before it is kept: its limits, its text, its time,
// its button and its picture.

const { normalizeAction, normalizeMedia, normalizePoll } = require('../community-messages.js');

const ID_RE = /^[a-z0-9][a-z0-9:_.-]{0,95}$/i;
const ENTRY_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const KINDS = new Set(['hub', 'drop', 'sparks', 'updates', 'support', 'share', 'rate']);

// Actions a message made by the app itself may carry, besides the feed's own.
const APP_ACTIONS = new Set(['sparks', 'share', 'installed']);
// What an update message is about: one Store entry at one version.
const STAMP_RE = /^[a-z0-9][a-z0-9_-]{0,60}@[0-9A-Za-z.+-]{1,40}$/;
const MAX_STAMPS = 60;
const SURFACES = new Set(['any', 'dashboard']);

const TITLE_MAX = 120;
const LINE_MAX = 240;
const BODY_MAX = 600;
const LABEL_MAX = 40;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

const cleanTime = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function cleanAction(raw, entryId) {
  if (!raw || typeof raw !== 'object') return null;
  if (APP_ACTIONS.has(raw.type)) {
    const label = cleanText(raw.label, LABEL_MAX);
    return label ? { type: raw.type, label } : null;
  }
  const action = normalizeAction(raw, entryId);
  return action && action.type !== 'dismiss' ? action : null;
}

// One message in the shape every screen trusts, or null.
function cleanMessage(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  const title = cleanText(raw.title, TITLE_MAX);
  if (!id || !title || !KINDS.has(raw.kind)) return null;

  const msg = {
    id,
    kind: raw.kind,
    at: Math.min(cleanTime(raw.at) || now, now),
    title,
    line: cleanText(raw.line, LINE_MAX),
    body: cleanText(raw.body, BODY_MAX),
    where: raw.where === 'stage' ? 'stage' : 'corner',
    surface: SURFACES.has(raw.surface) ? raw.surface : 'any',
    shownAt: 0,
    readAt: 0,
  };
  if (raw.kind === 'updates') {
    const stamps = Array.isArray(raw.stamps) ? raw.stamps.filter((s) => typeof s === 'string' && STAMP_RE.test(s)).slice(0, MAX_STAMPS) : [];
    if (!stamps.length) return null;
    msg.stamps = stamps;
  }
  const entryId = typeof raw.entryId === 'string' && ENTRY_RE.test(raw.entryId) ? raw.entryId : '';
  if (entryId) msg.entryId = entryId;
  const expires = cleanTime(raw.expires);
  if (expires) msg.expires = expires;
  const since = raw.kind === 'rate' ? cleanTime(raw.since) : 0;
  if (since) msg.since = since;
  const media = normalizeMedia(raw.media);
  if (media) msg.media = media;
  const action = cleanAction(raw.action, entryId);
  if (action) msg.action = action;
  const poll = raw.poll ? normalizePoll(raw.poll) : null;
  if (poll) {
    msg.poll = poll;
    // A question is answered in the corner, on any screen: the stage has no answers.
    msg.where = 'corner';
  }
  return msg;
}

// What was on disk, trusted no more than what arrives from a page.
function restoreMessage(raw, now) {
  const msg = cleanMessage(raw, now);
  if (!msg) return null;
  msg.shownAt = cleanTime(raw.shownAt);
  msg.readAt = cleanTime(raw.readAt);
  if (msg.poll && msg.poll.options.some((o) => o.id === raw.answer)) msg.answer = raw.answer;
  return msg;
}

module.exports = {
  ID_RE, ENTRY_RE, KINDS, APP_ACTIONS, STAMP_RE, MAX_STAMPS, SURFACES, TITLE_MAX, LINE_MAX,
  BODY_MAX, LABEL_MAX, cleanText, cleanTime, cleanAction, cleanMessage, restoreMessage,
};
