'use strict';
// What Discord is asked about voice: the voice channels, who is in them, the channel the user
// is in, the soundboard, and the full voice state the tile shows.

const { GUILD_VOICE } = require('./rpc-limits.js');
const {
  isSnowflake, channelMembers, isSoundId, parseSoundRef, normSound,
} = require('./rpc-shapes.js');

function makeVoiceReads({ creds, watchState, command }) {
  // Our own account id, for the self check below. Reads the persisted creds
  // (identify wrote it at link time); '' when unknown, which fails open — the
  // refusal is a UX nicety, not a security boundary.
  async function selfUserId() {
    try { const c = await creds(); return c && c.userId ? String(c.userId) : ''; }
    catch { return ''; }
  }

  // Enumerate the user's guild voice channels (id/name/guild/guildId), capped.
  // Shared by the editor picker (listVoiceChannels) and the widget roster
  // (voiceRoster). Best-effort: a guild we can't read is skipped.
  //
  // guildId rides along with the name because the widget's Channels tab remembers
  // which servers the user collapsed, and it has to remember them by something
  // that survives a rename — and that tells two servers with the same name apart.
  async function enumVoiceChannels(cap) {
    const g = await command('GET_GUILDS');
    const guilds = (g && Array.isArray(g.guilds)) ? g.guilds.slice(0, 30) : [];
    const out = [];
    for (const guild of guilds) {
      if (out.length >= cap) break;
      try {
        const ch = await command('GET_CHANNELS', { guild_id: guild.id });
        const chans = (ch && Array.isArray(ch.channels)) ? ch.channels : [];
        for (const c of chans) {
          if (c.type === GUILD_VOICE && out.length < cap) {
            out.push({ id: String(c.id), name: c.name || '', guild: guild.name || '', guildId: String(guild.id || '') });
          }
        }
      } catch { /* skip unreadable guild */ }
    }
    return out;
  }

  // Voice channels across the user's guilds, for the editor picker. Degrades to []
  // so an offline Discord falls back to a typed channel-id field.
  async function listVoiceChannels() {
    try { return await enumVoiceChannels(300); } catch { return []; }
  }

  // Live roster for the widget's Channels tab: who is currently connected in each
  // voice channel. GET_CHANNELS only lists the channels, so we GET_CHANNEL each one
  // to read its voice_states. Capped (a user with many channels can't fan out into
  // hundreds of calls) and read in bounded-parallel batches to stay responsive
  // without flooding the pipe. Client-safe (display name + mute/deaf only, via
  // channelMembers — no tokens/avatars). Degrades to { ok:false } like voiceState().
  async function voiceRoster(cap = 40) {
    try {
      const chans = await enumVoiceChannels(cap);
      const channels = [];
      const BATCH = 6;
      for (let i = 0; i < chans.length; i += BATCH) {
        const filled = await Promise.all(chans.slice(i, i + BATCH).map(async (vc) => {
          try {
            const full = await command('GET_CHANNEL', { channel_id: vc.id });
            return { id: vc.id, name: vc.name, guild: vc.guild, guildId: vc.guildId, members: channelMembers(full) };
          } catch { return { id: vc.id, name: vc.name, guild: vc.guild, guildId: vc.guildId, members: [] }; }
        }));
        for (const r of filled) channels.push(r);
      }
      return { ok: true, channels };
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }

  // ── Soundboard (UNDOCUMENTED RPC: GET_SOUNDBOARD_SOUNDS / PLAY_SOUNDBOARD_SOUND) ─
  // The Discord desktop client drives its soundboard over these two RPC commands,
  // but Discord does not document them — so they're best-effort: a client update
  // could change or drop them, and both degrade to []/{ok:false} like the rest of
  // the provider. Playing a sound targets the voice channel the user is CURRENTLY
  // in (the same effect as clicking the sound in Discord's own soundboard panel);
  // it needs no extra scope beyond the voice ones already granted.
  //
  // The channel the user is currently connected to (guild voice channel), read on
  // demand so a soundboard play lands in the right place. Uses the watch's learned
  // id when live (covers DM/group calls), else asks Discord directly. null = none.
  async function currentChannelId() {
    if (watchState.currentVoiceChannelId) return watchState.currentVoiceChannelId;
    try { const ch = await command('GET_SELECTED_VOICE_CHANNEL'); return (ch && ch.id) ? String(ch.id) : null; }
    catch { return null; }
  }

  // The user's usable soundboard sounds (guild + built-in), for the editor picker.
  // Client-safe: id + origin-guild id + name + a "Server" label only (no tokens,
  // no audio). Degrades to [] so an offline Discord leaves the picker empty rather
  // than erroring. Capped so a user in many servers can't bloat the response.
  async function listSoundboardSounds(cap = 500) {
    try {
      const data = await command('GET_SOUNDBOARD_SOUNDS');
      const raw = Array.isArray(data) ? data : (data && Array.isArray(data.sounds) ? data.sounds : []);
      const sounds = [];
      for (const s of raw) { const n = normSound(s); if (n) sounds.push(n); if (sounds.length >= cap) break; }
      // Best-effort guild names so the picker can label "Server › Sound".
      const names = {};
      try {
        const g = await command('GET_GUILDS');
        const guilds = (g && Array.isArray(g.guilds)) ? g.guilds : [];
        for (const gu of guilds) if (gu && gu.id) names[String(gu.id)] = gu.name || '';
      } catch { /* labels are optional */ }
      return sounds.map((s) => ({ id: s.id, guildId: s.guildId, name: s.name, guild: names[s.guildId] || '' }));
    } catch { return []; }
  }

  // Play a soundboard sound into the user's current voice channel. sound_id is
  // required; guild_id (the sound's origin server) is sent when known so Discord
  // can locate a guild sound; channel_id pins the target channel (mirrors what the
  // desktop client sends, and sidesteps an "Invalid Sound" when both are set).
  async function playSoundboard(ref) {
    const { soundId, guildId } = parseSoundRef(ref);
    if (!isSoundId(soundId)) return { ok: false, error: 'bad_sound' };
    const payload = { sound_id: soundId };
    if (isSnowflake(guildId)) payload.guild_id = guildId;
    const chId = await currentChannelId();
    if (chId) payload.channel_id = chId;
    await command('PLAY_SOUNDBOARD_SOUND', payload);
    return { ok: true };
  }

  // Current voice state for the dashboard widget: self mute/deaf, voice mode,
  // input/output volumes, the audio-processing toggles, and the voice channel the
  // user is in (or null). Client-safe (no tokens/devices). Best-effort — a closed
  // Discord or a missing token degrades to { ok:false } so the widget shows the
  // "not linked" / offline state instead of erroring.
  async function voiceState() {
    try {
      const vs = await command('GET_VOICE_SETTINGS');
      // Which of the people in the list is YOU. Discord has no per-user setting
      // for your own account (your levels are discordInputVol/OutputVol), so the
      // widget needs this to leave your own row alone rather than offering a
      // slider that answers `self_not_supported`. Your own id, on your own
      // dashboard, next to your own name — nothing is revealed that the list
      // does not already show.
      const selfId = await selfUserId();
      let channel = null;
      let members = [];
      try {
        let ch = await command('GET_SELECTED_VOICE_CHANNEL');
        // GET_SELECTED_VOICE_CHANNEL only reports GUILD voice channels — it returns
        // null for DM/group CALLS. When a VOICE_CHANNEL_SELECT event told us the
        // current channel (e.g. a DM call joined while watching), read it directly.
        if ((!ch || !ch.id) && watchState.currentVoiceChannelId) {
          try { ch = await command('GET_CHANNEL', { channel_id: watchState.currentVoiceChannelId }); }
          catch { /* channel not readable — leave as not-in-a-channel */ }
        }
        if (ch && ch.id) {
          channel = { id: String(ch.id), name: ch.name || '' };
          members = channelMembers(ch);
        }
      } catch (e) {
        // A genuine RPC error (not just "not in a channel") — surface it so a scope/
        // permission problem is diagnosable instead of silently looking idle.
        console.warn('[discord] voice-channel read failed:', (e && e.message) || e);
      }
      const vol = (side) => (vs && vs[side] && Number.isFinite(vs[side].volume) ? Math.round(vs[side].volume) : null);
      return {
        ok: true, connected: true,
        mute: !!(vs && vs.mute), deaf: !!(vs && vs.deaf),
        mode: (vs && vs.mode && vs.mode.type) || '',
        inputVolume: vol('input'), outputVolume: vol('output'),
        features: {
          noise_suppression: !!(vs && vs.noise_suppression),
          echo_cancellation: !!(vs && vs.echo_cancellation),
          automatic_gain_control: !!(vs && vs.automatic_gain_control),
          qos: !!(vs && vs.qos),
        },
        channel, members, selfId,
      };
    } catch (e) {
      const msg = (e && e.message) || 'discord_failed';
      return { ok: false, error: msg === 'not_connected' ? 'not_connected' : msg };
    }
  }


  return {
    selfUserId, listVoiceChannels, voiceRoster, currentChannelId, listSoundboardSounds,
    playSoundboard, voiceState,
  };
}

module.exports = { makeVoiceReads };
