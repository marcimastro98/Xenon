// What the assistant does when asked to drive a live stream: OBS, Twitch, the YouTube
// broadcast, Streamer.bot, each through the same list of actions as a Deck key.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
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

  'spotify_control': async ({ fnArgs, runAction }, { streams }) => {
      let fnResult;
      // Full Spotify control. Transport/shuffle/repeat/like/volume/seek/device
      // route through the allowlisted registry; play/queue-by-name and the status
      // read use the provider directly (search resolves the concrete URI).
      const action = String(fnArgs.action || '');
      const query = String(fnArgs.query || '');
      const value = String(fnArgs.value || '');
      if (action === 'status') {
        const [player, devices] = await Promise.all([
          streams.spotify.getPlayer().catch(() => null),
          streams.spotify.getDevices().catch(() => null),
        ]);
        fnResult = { ok: true, nowPlaying: player, devices: (devices && devices.devices) || [] };
      } else if (action === 'play_song') {
        fnResult = await streams.spotify.playSearch(query);
      } else if (action === 'queue_song') {
        fnResult = await streams.spotify.queueSearch(query);
      } else {
        const seekMs = Math.max(0, Math.round((parseFloat(value) || 0) * 1000));
        const map = {
          play: { type: 'spotifyPlay', mode: 'play' },
          pause: { type: 'spotifyPlay', mode: 'pause' },
          next: { type: 'spotifyNext' },
          previous: { type: 'spotifyPrev' },
          shuffle_on: { type: 'spotifyShuffle', mode: 'on' },
          shuffle_off: { type: 'spotifyShuffle', mode: 'off' },
          repeat: { type: 'spotifyRepeat', mode: ['off', 'context', 'track'].includes(value) ? value : 'toggle' },
          like: { type: 'spotifyLike', mode: 'like' },
          unlike: { type: 'spotifyLike', mode: 'unlike' },
          volume: { type: 'spotifyVolume', mode: 'set', value },
          seek: { type: 'spotifySeek', value: seekMs },
          play_playlist: { type: 'spotifyPlaylist', playlist: query },
          device: { type: 'spotifyDevice', device: query },
        };
        const act = map[action];
        fnResult = act ? await runAction(act) : { error: 'bad_action' };
      }
      return fnResult;
  },
};

module.exports = { branches };
