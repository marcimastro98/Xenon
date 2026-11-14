'use strict';
// What can be done to Discord voice: mute, deafen, push to talk, join and leave a channel, open
// a text channel, the volumes, one person's volume and mute, the audio switches, and the one
// door every Deck action comes through.

const { AUDIO_FEATURES, MAX_USER_OVERRIDES } = require('./rpc-limits.js');
const {
  DEFAULT_USER_VOL, toggleValue, nextPttType, nudgedVolume, userVolumeFor,
} = require('./rpc-voice-values.js');
const { isSnowflake, channelMembers } = require('./rpc-shapes.js');

function makeVoiceActions({
  userOverrides, selfUserId, currentChannelId, playSoundboard, bumpIdle, command,
}) {
  // ── Voice actions (each resolves to { ok } and never throws) ──────────────
  async function setSelf(field, mode, onWord, offWord) {
    let value;
    if (mode === onWord) value = true;
    else if (mode === offWord) value = false;
    else { const cur = await command('GET_VOICE_SETTINGS'); value = toggleValue(mode, !!(cur && cur[field]), onWord, offWord); }
    await command('SET_VOICE_SETTINGS', { [field]: value });
    return { ok: true };
  }

  async function setPtt(mode) {
    let type;
    if (mode === 'ptt' || mode === 'vad') type = nextPttType(mode);
    else { const cur = await command('GET_VOICE_SETTINGS'); type = nextPttType('toggle', cur && cur.mode && cur.mode.type); }
    await command('SET_VOICE_SETTINGS', { mode: { type } });
    return { ok: true };
  }

  async function selectVoice(channelId) {
    const id = String(channelId == null ? '' : channelId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_channel' };
    await command('SELECT_VOICE_CHANNEL', { channel_id: id, force: true });
    return { ok: true };
  }

  // Show one text channel, group DM or DM in the Discord app (SELECT_TEXT_CHANNEL,
  // under the `rpc` scope every linked account already granted). Used by the
  // widget's "Reply" on a mirrored notification: Discord has no RPC command that
  // SENDS a message, so the closest honest thing is taking the user to the chat.
  // Never throws; the error is the RPC one, which discord-launch.js reads to
  // decide whether a starting Discord is worth waiting for.
  async function openTextChannel(channelId) {
    const id = String(channelId == null ? '' : channelId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_channel' };
    try {
      await command('SELECT_TEXT_CHANNEL', { channel_id: id });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'discord_failed' };
    }
  }

  async function leaveVoice() {
    await command('SELECT_VOICE_CHANNEL', { channel_id: null });
    return { ok: true };
  }

  async function nudgeVolume(field, max, dir) {
    const cur = await command('GET_VOICE_SETTINGS');
    const now = cur && cur[field] && Number.isFinite(cur[field].volume) ? cur[field].volume : 0;
    await command('SET_VOICE_SETTINGS', { [field]: { volume: nudgedVolume(now, dir, max) } });
    return { ok: true };
  }

  // Absolute volume for slider keys: `value` is a 0–100 percentage from the
  // validated action. Deliberately capped at 100 even for the output field
  // (whose native range reaches 200%) — a slider spans the normal range; the
  // boost range stays a deliberate in-app choice.
  async function setVolumeAbs(field, value) {
    // Empty/whitespace rejects loud — Number('') is 0 and would mute the user.
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { ok: false, error: 'bad_value' };
    const pct = Number(raw.replace(',', '.'));
    if (!Number.isFinite(pct)) return { ok: false, error: 'bad_value' };
    const vol = Math.min(100, Math.max(0, Math.round(pct)));
    await command('SET_VOICE_SETTINGS', { [field]: { volume: vol } });
    return { ok: true };
  }

  // ── Per-user local playback (SET_USER_VOICE_SETTINGS) ─────────────────────
  // Turn ONE person in your voice channel up, down or off, exactly like dragging
  // their slider in Discord's own UI. This never leaves the machine: it changes
  // what this client plays, not what anyone else hears, and it is not a moderation
  // action — a member with no permissions can do it to anybody.
  //
  // Remember (or forget) that a user is sitting on a non-default local setting.
  // Only the socket hold in bumpIdle() reads this; it is not a cache of Discord's
  // state, so a missed entry costs an earlier idle-close, never a wrong value.
  function noteOverride(id, patch) {
    const prev = userOverrides.get(id) || { volume: DEFAULT_USER_VOL, mute: false };
    const next = { volume: patch.volume != null ? patch.volume : prev.volume, mute: patch.mute != null ? patch.mute : prev.mute };
    if (next.volume === DEFAULT_USER_VOL && !next.mute) { userOverrides.delete(id); bumpIdle(); return; }
    if (!userOverrides.has(id) && userOverrides.size >= MAX_USER_OVERRIDES) return;   // apply anyway, just don't track
    userOverrides.set(id, next);
  }

  // The member's current local settings, read live from the channel the user is
  // in. Needed for up/down and for a mute toggle, and it doubles as the "is this
  // person actually here" check — Discord silently accepts settings for a user
  // who isn't in the channel, which would look like a control that did nothing.
  async function memberVoice(userId) {
    const chId = await currentChannelId();
    if (!chId) return { ok: false, error: 'not_in_channel' };
    let ch;
    try { ch = await command('GET_CHANNEL', { channel_id: chId }); }
    catch { return { ok: false, error: 'not_in_channel' }; }
    // A generous cap for the LOOKUP (the SSE roster stays capped at 50): a
    // person past the display cap is still someone you can turn down.
    const member = channelMembers(ch, 500).find((m) => m.id === userId);
    return member ? { ok: true, member } : { ok: false, error: 'user_not_here' };
  }

  // Shared front half of both per-user actions: validate the id and refuse our
  // own account. Discord has no per-user setting for yourself — your own levels
  // are discordInputVol/discordOutputVol — so a widget that puts a slider on
  // every row gets a named error instead of a call that reports success and
  // changes nothing.
  async function userTarget(userId) {
    const id = String(userId == null ? '' : userId).trim();
    if (!isSnowflake(id)) return { ok: false, error: 'bad_user' };
    if (id === await selfUserId()) return { ok: false, error: 'self_not_supported' };
    return { ok: true, id };
  }

  // Both actions read the channel first, even when the value is known up front
  // and no read is needed to compute it. That read is the ONLY thing that tells
  // "you are not in a call" and "that person just left" apart from success:
  // Discord accepts settings for a user who isn't there and answers OK, which
  // would give the widget a control that reports success and changes nothing.
  // It costs one local IPC round trip, and widget actions are already capped at
  // one per 250ms, so even a dragged slider pays nothing that matters.
  async function setUserVolume(userId, mode, value) {
    const target = await userTarget(userId);
    if (!target.ok) return target;
    const cur = await memberVoice(target.id);
    if (!cur.ok) return cur;
    const volume = userVolumeFor(mode, cur.member.volume, value);
    if (volume == null) return { ok: false, error: 'bad_value' };
    await command('SET_USER_VOICE_SETTINGS', { user_id: target.id, volume });
    noteOverride(target.id, { volume });
    return { ok: true };
  }

  async function setUserMute(userId, mode) {
    const target = await userTarget(userId);
    if (!target.ok) return target;
    const cur = await memberVoice(target.id);
    if (!cur.ok) return cur;
    const mute = mode === 'mute' ? true : (mode === 'unmute' ? false : !cur.member.localMute);
    await command('SET_USER_VOICE_SETTINGS', { user_id: target.id, mute });
    noteOverride(target.id, { mute });
    return { ok: true };
  }

  async function toggleAudioFeature(feature) {
    if (!AUDIO_FEATURES.has(feature)) return { ok: false, error: 'bad_feature' };
    const cur = await command('GET_VOICE_SETTINGS');
    await command('SET_VOICE_SETTINGS', { [feature]: !(cur && cur[feature]) });
    return { ok: true };
  }

  // The single entry point the Deck registry dispatches to. `action` is already
  // validated by the shared catalog (mode/feature coerced to allowed options).
  async function runAction(action) {
    const a = action || {};
    try {
      switch (a.type) {
        case 'discordMute':   return await setSelf('mute', a.mode, 'mute', 'unmute');
        case 'discordDeafen': return await setSelf('deaf', a.mode, 'deafen', 'undeafen');
        case 'discordPtt':    return await setPtt(a.mode);
        case 'discordJoin':   return await selectVoice(a.channel);
        case 'discordLeave':  return await leaveVoice();
        case 'discordInputVol':  return a.mode === 'set' ? await setVolumeAbs('input', a.value) : await nudgeVolume('input', 100, a.mode);
        case 'discordOutputVol': return a.mode === 'set' ? await setVolumeAbs('output', a.value) : await nudgeVolume('output', 200, a.mode);
        case 'discordUserVol':  return await setUserVolume(a.user, a.mode, a.value);
        case 'discordUserMute': return await setUserMute(a.user, a.mode);
        case 'discordAudioToggle': return await toggleAudioFeature(a.feature);
        case 'discordSoundboard':  return await playSoundboard(a.sound);
        default: return { ok: false, error: 'unsupported' };
      }
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  return { openTextChannel, runAction };
}

module.exports = { makeVoiceActions };
