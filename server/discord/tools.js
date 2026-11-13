// What the assistant does in a Discord voice call: mute, deafen, join and leave.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'discord_voice': async ({ fnArgs, runAction }, { discordLink }) => {
      let fnResult;
      // Discord voice control. `status` reads the live voice state + joinable
      // channels; `join` resolves a channel NAME → snowflake before the registry
      // call; the rest map straight onto the allowlisted Discord actions.
      const action = String(fnArgs.action || '');
      if (action === 'status') {
        const [st, chans] = await Promise.all([
          discordLink.rpc.voiceState().catch(() => null),
          discordLink.rpc.listVoiceChannels().catch(() => []),
        ]);
        fnResult = { ok: true, voice: st, channels: (Array.isArray(chans) ? chans : []).slice(0, 60) };
      } else if (action === 'join') {
        const name = String(fnArgs.channel || '').trim().toLowerCase();
        if (!name) { fnResult = { error: 'no_channel' }; }
        else {
          const chans = await discordLink.rpc.listVoiceChannels().catch(() => []);
          const match = (Array.isArray(chans) ? chans : []).find(c => String(c.name || '').toLowerCase() === name)
            || (Array.isArray(chans) ? chans : []).find(c => String(c.name || '').toLowerCase().includes(name));
          fnResult = match ? await runAction({ type: 'discordJoin', channel: match.id }) : { error: 'channel_not_found' };
        }
      } else {
        const mode = String(fnArgs.mode || '') === 'down' ? 'down' : 'up';
        const map = {
          mute: { type: 'discordMute', mode: 'mute' },
          unmute: { type: 'discordMute', mode: 'unmute' },
          deafen: { type: 'discordDeafen', mode: 'deafen' },
          undeafen: { type: 'discordDeafen', mode: 'undeafen' },
          ptt: { type: 'discordPtt', mode: 'ptt' },
          vad: { type: 'discordPtt', mode: 'vad' },
          leave: { type: 'discordLeave' },
          input_volume: { type: 'discordInputVol', mode },
          output_volume: { type: 'discordOutputVol', mode },
          audio_toggle: { type: 'discordAudioToggle', feature: String(fnArgs.feature || '') },
        };
        const act = map[action];
        fnResult = act ? await runAction(act) : { error: 'bad_action' };
      }
      return fnResult;
  },
};

module.exports = { branches };
