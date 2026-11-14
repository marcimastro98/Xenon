'use strict';
// Builds what is sent to Streamer.bot: the answer to its sign-in challenge, the arguments of an
// action, and the request an action of a Deck key becomes.

const crypto = require('node:crypto');

// Streamer.bot auth: base64(sha256( base64(sha256(password+salt)) + challenge )).
function computeAuth(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(String(password) + String(salt)).digest('base64');
  return crypto.createHash('sha256').update(secret + String(challenge)).digest('base64');
}

// Parse an optional user-supplied "arguments" field (a JSON object typed in the
// editor) into a safe, shallow, string-keyed map of scalar values — or undefined
// when empty/invalid. Streamer.bot's DoAction/ExecuteCodeTrigger accept an `args`
// object exposed to the action; we cap key/value size and count so a stray blob
// can't bloat the frame, and drop nested objects/arrays (SB args are flat).
function parseArgs(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return undefined; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ >= 32) break;
    const v = obj[k];
    if (v == null || typeof v === 'object') continue;
    out[String(k).slice(0, 100)] = typeof v === 'string' ? v.slice(0, 1024) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Map a validated deck streamer.bot action to a WS request, or null if invalid.
// Field shapes verified against the official Streamer.bot client:
//   DoAction            -> { action:{id}, args? }   (id from the live GetActions list,
//                           stable across renames, unlike the display name)
//   SendMessage         -> { platform, message, bot, internal }
//   ExecuteCodeTrigger  -> { triggerName, args? }
function streamerbotRequest(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.type === 'sbDoAction') {
    const id = String(action.action || '').trim();
    if (!id) return null;
    const args = parseArgs(action.args);
    const req = { request: 'DoAction', action: { id } };
    if (args) req.args = args;
    return req;
  }
  if (action.type === 'sbSendMessage') {
    const platform = String(action.platform || '').trim().toLowerCase();
    if (!['twitch', 'youtube', 'kick', 'trovo'].includes(platform)) return null;
    const message = String(action.message || '').trim();
    if (!message) return null;
    // Default to the bot account; 'broadcaster' sends from the streamer's own chat.
    const bot = action.sendAs !== 'broadcaster';
    return { request: 'SendMessage', platform, message: message.slice(0, 500), bot, internal: false };
  }
  if (action.type === 'sbCodeTrigger') {
    const triggerName = String(action.trigger || '').trim();
    if (!triggerName) return null;
    const args = parseArgs(action.args);
    const req = { request: 'ExecuteCodeTrigger', triggerName };
    if (args) req.args = args;
    return req;
  }
  return null;
}

module.exports = { computeAuth, parseArgs, streamerbotRequest };
