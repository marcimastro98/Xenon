'use strict';
// What the Discord app sends turned into what the tile draws: the people in a voice channel
// with their pictures, soundboard sounds, and notifications.

// A Discord snowflake id (channel/guild/user) is a run of digits. Validate any
// channel id from the wire before sending it to SELECT_VOICE_CHANNEL.
function isSnowflake(s) { return typeof s === 'string' && /^\d{5,25}$/.test(s.trim()); }

// Map a GET_SELECTED_VOICE_CHANNEL response to a client-safe member list for the
// widget: display name (server nick > global name > username), the avatar's
// public CDN address (avatarUrl), muted/deafened flags (server- or self-imposed),
// what THIS machine hears them at, and a speaking placeholder the live watch
// fills in. No tokens or emails, capped so a huge channel can't bloat the SSE
// payload.
//
// Two different mutes live in one RPC entry and they are not interchangeable:
// `voice_state.mute`/`self_mute` is the member's OWN microphone state (everyone
// in the channel sees the same value), while the top-level `mute`/`volume`/`pan`
// are the local playback settings of THIS client — the ones the per-user volume
// action writes. Keeping them apart is what lets a widget show "they muted
// themselves" and "I turned them down" as the different things they are.
// A member's avatar on Discord's CDN, as a fixed https URL built from two
// checked values: never a string from the wire. A custom avatar is a 32-hex
// hash (`a_` in front when it is animated: the .png is its still first frame,
// which is also lighter on a dashboard). Without one, Discord's own default
// avatar: picked by (id >> 22) % 6 for accounts on the new usernames, or by the
// legacy discriminator % 5. 64px covers the 20px chip at 3x.
function avatarUrl(user) {
  const id = user && typeof user.id === 'string' ? user.id.trim() : '';
  if (!isSnowflake(id)) return '';
  const hash = typeof user.avatar === 'string' ? user.avatar : '';
  if (/^(a_)?[0-9a-f]{32}$/.test(hash)) return 'https://cdn.discordapp.com/avatars/' + id + '/' + hash + '.png?size=64';
  const disc = typeof user.discriminator === 'string' ? user.discriminator : '';
  const index = /^\d{1,4}$/.test(disc) && disc !== '0' && disc !== '0000'
    ? Number(disc) % 5
    : Number((BigInt(id) >> 22n) % 6n);
  return 'https://cdn.discordapp.com/embed/avatars/' + index + '.png';
}

function channelMembers(ch, cap = 50) {
  const states = ch && Array.isArray(ch.voice_states) ? ch.voice_states : [];
  const out = [];
  for (const vs of states) {
    const u = vs && vs.user;
    if (!u || !u.id) continue;
    const st = vs.voice_state || {};
    out.push({
      id: String(u.id),
      name: vs.nick || u.global_name || u.username || '',
      avatar: avatarUrl(u),
      mute: !!(st.mute || st.self_mute),
      deaf: !!(st.deaf || st.self_deaf),
      // null (not 100) when Discord doesn't report it: a slider that opens at a
      // guessed value would show a setting the machine isn't actually in.
      volume: Number.isFinite(vs.volume) ? Math.round(vs.volume) : null,
      localMute: !!vs.mute,
      speaking: false,
    });
    if (out.length >= cap) break;
  }
  return out;
}

// A soundboard sound id: a run of digits. Guild sounds are snowflakes; the
// built-in default sounds have small integer ids, so accept 1-25 digits (unlike
// isSnowflake, which requires ≥5 for channel/guild/user ids).
function isSoundId(s) { return typeof s === 'string' && /^\d{1,25}$/.test(s.trim()); }

// A Deck soundboard action stores its target as an opaque "<guildId>|<soundId>"
// ref (default sounds carry an empty guild). Split it back into its parts;
// tolerate a bare sound id (no separator) for forward-compat.
function parseSoundRef(ref) {
  const s = String(ref == null ? '' : ref);
  const i = s.indexOf('|');
  if (i < 0) return { guildId: '', soundId: s.trim() };
  return { guildId: s.slice(0, i).trim(), soundId: s.slice(i + 1).trim() };
}

// Project a raw NOTIFICATION_CREATE payload to the client-safe shape the feed
// renders: title/body text (length-capped; the widget routes them through
// textContent), the channel id, and the avatar icon URL — https: ONLY, per the
// scheme-allowlist invariant, since it lands in an <img src>. Returns null for a
// payload with no usable text so junk never reaches the buffer.
function normNotification(p) {
  if (!p || typeof p !== 'object') return null;
  const title = (typeof p.title === 'string' ? p.title : '').trim().slice(0, 140);
  const body = (typeof p.body === 'string' ? p.body : '').trim().slice(0, 280);
  if (!title && !body) return null;
  const chId = typeof p.channel_id === 'string' ? p.channel_id : '';
  let icon = '';
  const rawIcon = typeof p.icon_url === 'string' ? p.icon_url.trim() : '';
  if (rawIcon) {
    try { const u = new URL(rawIcon); if (u.protocol === 'https:') icon = u.href.slice(0, 500); }
    catch { /* unparsable URL → no icon */ }
  }
  // The message's TYPE, when Discord sends the message object. Type 3 is CALL,
  // which is what a ringing DM/group call writes into the channel — the only
  // language-independent "this is a call" signal available anywhere in this
  // product (see call-detect.js). It is a small integer from a closed set, so
  // it is projected as a number and nothing else of the message travels.
  // Strict: a real number or nothing. Coercing '3' would mean a payload that
  // merely looks numeric can raise a full-screen ringing card, and this is a
  // trust boundary — the only cost of being strict is that a hypothetical
  // future Discord sending strings would fall back to the wording path.
  const msg = p.message && typeof p.message === 'object' ? p.message : null;
  const messageType = msg && typeof msg.type === 'number' && Number.isFinite(msg.type) ? msg.type : null;
  return { title, body, icon, channelId: isSnowflake(chId) ? chId : '', messageType };
}

// Normalize one raw GET_SOUNDBOARD_SOUNDS entry to a client-safe shape. These
// RPC commands are UNDOCUMENTED, so the field names aren't guaranteed — accept
// sound_id|id and guild_id|guildId, and fall back to the id/emoji for a label.
// Returns null for an entry with no usable id.
function normSound(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.sound_id || s.id || '').trim();
  if (!isSoundId(id)) return null;
  const guildId = String(s.guild_id || s.guildId || '').trim();
  const name = String(s.name || s.emoji_name || id);
  return { id, guildId: isSnowflake(guildId) ? guildId : '', name };
}

module.exports = {
  isSnowflake, avatarUrl, channelMembers, isSoundId, parseSoundRef, normNotification, normSound,
};
