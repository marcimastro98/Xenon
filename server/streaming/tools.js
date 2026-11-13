// What the assistant does when asked to drive a live stream: OBS, Twitch, the YouTube
// broadcast, Streamer.bot, each through the same list of actions as a Deck key.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any) => Promise<any>>} */
const branches = {
  'obs_control': async ({ fnArgs, runAction }) => {
      let fnResult;
      // Route through the same allowlisted deck registry that Deck keys use, so
      // validation/normalisation lives in one place. A missing OBS connection
      // comes back as {error:'obs_unavailable'} — the model tells the user.
      const map = {
        start_recording: { type: 'obsRecord', mode: 'start' },
        stop_recording: { type: 'obsRecord', mode: 'stop' },
        toggle_recording: { type: 'obsRecord', mode: 'toggle' },
        start_streaming: { type: 'obsStream', mode: 'start' },
        stop_streaming: { type: 'obsStream', mode: 'stop' },
        toggle_streaming: { type: 'obsStream', mode: 'toggle' },
        switch_scene: { type: 'obsScene', scene: String(fnArgs.scene || '') },
        next_scene: { type: 'obsSceneNext' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await runAction(action) : { error: 'bad_action' };
      return fnResult;
  },

  'twitch_action': async ({ fnArgs, runAction }) => {
      let fnResult;
      const value = String(fnArgs.value || '');
      const map = {
        create_clip: { type: 'twitchClip' },
        set_title: { type: 'twitchTitle', title: value },
        set_game: { type: 'twitchGame', game: value },
        send_chat: { type: 'twitchChat', message: value },
        marker: { type: 'twitchMarker', description: value },
        shoutout: { type: 'twitchShoutout', login: value },
        chat_mode: { type: 'twitchChatMode', mode: value },
        run_ad: { type: 'twitchAd', length: value || '60' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await runAction(action) : { error: 'bad_action' };
      return fnResult;
  },

  'youtube_broadcast': async ({ fnArgs, runAction }) => {
      let fnResult;
      fnResult = await runAction({ type: 'ytBroadcast', mode: String(fnArgs.mode || 'toggle') });
      return fnResult;
  },

  'streamerbot_action': async ({ fnArgs, runAction }) => {
      let fnResult;
      const act = String(fnArgs.action || '').trim();
      fnResult = act ? await runAction({ type: 'sbDoAction', action: act }) : { error: 'no_action' };
      return fnResult;
  },
};

module.exports = { branches };
