// The tools the assistant gets for the integrations the user connected, and the lines that tell
// the model they exist.

const { readHubSettings } = require('../settings/read.js');
const { streamingLive } = require('./live.js');
const { streams } = require('./providers.js');
const { discordLink } = require('../discord/link.js');

// System instruction for a Live voice session: date/time, identity, spoken-answer
// brief, remembered facts, optional rolling summary carried from the client, and
// the reply language. Mirrors the /api/ai SYS_BASE+SYS_VOICE spirit, compactly.
// The tools of the integrations the user connected (OBS, Twitch, YouTube, Streamer.bot,
// Spotify, Home Assistant, Discord voice), pushed onto `fns`, and the lines that tell
// the model they exist. Shared by the chat turn and Voice Live, so a spoken "play X
// on Spotify" or "turn on the lamp" works the same as a typed one.
async function addIntegrationAiFunctions(fns) {
  const AI_FUNCTIONS = fns;
  // STREAMING — OBS / Twitch / YouTube / Streamer.bot control. Exposed ONLY
  // when the matching integration is configured/connected (mirrors the deck
  // action-catalog gating), so non-streamers pay zero extra tokens. Every tool
  // routes through the same allowlisted deckRegistry that Deck keys use.
  let _streamingText = '';
  {
    const _s = (await readHubSettings().catch(() => null)) || {};
    const _tw = await streams.twitch.status().catch(() => ({ connected: false }));
    const _yt = await streams.youtube.status().catch(() => ({ connected: false }));
    const _enabled = [];
    if (_s.obsHost || streamingLive.obsWanted) {
      AI_FUNCTIONS.push({ name: 'obs_control', description: 'Control OBS Studio: start/stop/toggle recording or streaming, switch to a scene, or go to the next scene.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: start_recording, stop_recording, toggle_recording, start_streaming, stop_streaming, toggle_streaming, switch_scene, next_scene' },
        scene: { type: 'STRING', description: 'Scene name: required only for switch_scene' },
      }, required: ['action'] } });
      _enabled.push('OBS (recording, streaming, scene switching)');
    }
    if (_tw.connected) {
      AI_FUNCTIONS.push({ name: 'twitch_action', description: 'Control your Twitch channel: create a clip, set the stream title or game/category, send a chat message, drop a stream marker, shout out a channel, change chat mode, or run an ad.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: create_clip, set_title, set_game, send_chat, marker, shoutout, chat_mode, run_ad' },
        value: { type: 'STRING', description: 'The parameter: new title (set_title), game/category (set_game), message (send_chat), marker note (marker), channel login (shoutout), chat mode emoteonly|followers|subscribers|slow|off (chat_mode), or ad length in seconds (run_ad). Omit for create_clip.' },
      }, required: ['action'] } });
      _enabled.push('Twitch (clip, title, game, chat, marker, shoutout, chat mode, ad)');
    }
    if (_yt.connected) {
      AI_FUNCTIONS.push({ name: 'youtube_broadcast', description: 'Start, stop, or toggle your YouTube live broadcast.', parameters: { type: 'OBJECT', properties: {
        mode: { type: 'STRING', description: 'One of: start, stop, toggle' },
      }, required: ['mode'] } });
      _enabled.push('YouTube (start/stop broadcast)');
    }
    if (_s.streamerbotHost) {
      AI_FUNCTIONS.push({ name: 'streamerbot_action', description: 'Trigger a Streamer.bot action by its exact name.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'Exact Streamer.bot action name to run' },
      }, required: ['action'] } });
      _enabled.push('Streamer.bot (run actions)');
    }
    if (_enabled.length) {
      _streamingText = ' STREAMING CONTROL is available for: ' + _enabled.join('; ') + '.'
        + ' Use these tools when the user asks to control their stream (e.g. "start recording", "go live", "switch to my Gioco scene", "set the title to…", "clip that"). "Go live" on Twitch means start the OBS stream (obs_control start_streaming).'
        + ' If a tool returns an "unavailable"/"not_connected" error, tell the user that integration isn\'t connected and point them to Settings → Streaming.';
    }
  }
  // SMART DEVICE & MEDIA CONTROL — Spotify / Home Assistant / Discord voice.
  // Each tool is declared ONLY when its integration is connected/configured
  // (mirrors the streaming gate), so users without it pay zero extra tokens.
  // Every control routes through the same allowlisted deckRegistry the Deck +
  // widgets use; reads (now-playing, entity list, voice state) call the
  // provider instance directly, exactly like the existing data endpoints.
  let _integrationsText = '';
  {
    const _sp = await streams.spotify.status().catch(() => ({ connected: false }));
    const _dc = await discordLink.rpc.status().catch(() => ({ connected: false }));
    const _s2 = (await readHubSettings().catch(() => null)) || {};
    const _haCfg = (_s2.homeAssistant && typeof _s2.homeAssistant === 'object') ? _s2.homeAssistant : {};
    const _haOn = !!(_haCfg.url && _haCfg.token);
    const _bits = [];
    if (_sp.connected) {
      AI_FUNCTIONS.push({ name: 'spotify_control', description: 'Control Spotify in full: play/pause, next/previous track, PLAY A SPECIFIC SONG, artist, album or playlist by NAME (searches Spotify and starts it), add a song to the queue, shuffle on/off, repeat, save/like the current track, set the device volume, seek, switch the playback device, and read what is currently playing. Playback control needs Spotify Premium (a "premium_required" error means the account is not Premium).', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: play, pause, next, previous, play_song, queue_song, play_playlist, shuffle_on, shuffle_off, repeat, like, unlike, volume, seek, device, status. Use "status" to read the current track, playback state and available devices before answering "what\'s playing?" or when you need the device list.' },
        query: { type: 'STRING', description: 'The song/artist/album name for play_song and queue_song, the playlist name for play_playlist, or the device name for device. Omit otherwise.' },
        value: { type: 'STRING', description: 'The numeric/enum parameter: repeat mode (off|context|track, omit to cycle); volume 0-100; seek position in SECONDS. Omit otherwise.' },
      }, required: ['action'] } });
      _bits.push('Spotify (play/pause, next/prev, play or queue any song by name, playlists, shuffle, repeat, like, volume, seek, switch device)');
    }
    if (_haOn) {
      AI_FUNCTIONS.push({ name: 'home_assistant', description: 'Control the user\'s smart home through Home Assistant: list every device/entity with its current state, turn a device on/off/toggle, activate a scene, and control ANY device in fine detail (light brightness & colour, thermostat temperature, fan speed, cover position, media players, switches…) via a Home Assistant service call. When you do not already know the exact entity_id, call action "list" FIRST and match by the friendly name/area.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: list, turn_on, turn_off, toggle, scene, service. "list" returns all entities (id, friendly name, domain, area, state). "service" performs a detailed call (see service/data).' },
        entity_id: { type: 'STRING', description: 'The Home Assistant entity id, e.g. "light.living_room" or "climate.bedroom". Required for every action except list.' },
        service: { type: 'STRING', description: 'For action "service": the "<domain>.<service>" to call, e.g. "light.turn_on", "climate.set_temperature", "cover.set_cover_position", "fan.set_percentage".' },
        data: { type: 'STRING', description: 'For action "service": the service parameters as a JSON object string, e.g. {"brightness_pct":40,"color_name":"red"} or {"temperature":21}. Omit when the service takes no extra data.' },
      }, required: ['action'] } });
      _bits.push('Home Assistant (list devices, on/off/toggle, scenes, and detailed control: brightness, colour, temperature, fan speed, covers, media players)');
    }
    const _uCfg = (_s2.unifi && typeof _s2.unifi === 'object') ? _s2.unifi : {};
    if (_haOn || (_uCfg.host && _uCfg.username && _uCfg.password)) {
      AI_FUNCTIONS.push({ name: 'home_camera', description: 'The home\'s cameras (UniFi Protect, Home Assistant) and how the house is. "list": the cameras. "show": a camera\'s live picture in your reply; the user sees it, you do not. "look": you see one picture to say what is there, only when the user asks what is happening ("who rang?", "is there a parcel?"); the first time the user is asked for permission. "summary": open doors and windows, temperatures, lights on and the last ring, for "how is the house?". "events": what happened at home today and yesterday (rings, what the cameras picked out, doors and windows opened), for "what happened today?". Never say who a person is; nothing here opens, unlocks or answers a door.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: list, show, look, summary, events.' },
        camera: { type: 'STRING', description: 'For show and look: the camera\'s name, area or id from "list", e.g. "garden". Omit for the doorbell\'s camera after a ring, or when there is one camera.' },
      }, required: ['action'] } });
      _bits.push('the home\'s cameras and state (show a camera, look at it with the user\'s permission, how the house is)');
    }
    if (_dc.connected) {
      AI_FUNCTIONS.push({ name: 'discord_voice', description: 'Control the user\'s Discord voice settings via the desktop app: mute/unmute the microphone, deafen/undeafen, switch between push-to-talk and voice-activity, JOIN a voice channel by name, leave the current channel, nudge the input (mic) or output (speaker) volume up/down, toggle an audio-processing feature, and read the current voice state plus the list of available voice channels.', parameters: { type: 'OBJECT', properties: {
        action: { type: 'STRING', description: 'One of: mute, unmute, deafen, undeafen, ptt, vad, join, leave, input_volume, output_volume, audio_toggle, status. Use "status" to read the current mute/deafen state and the joinable channels before a join.' },
        channel: { type: 'STRING', description: 'The voice channel name to join (for action join). Matched case-insensitively against the user\'s channels.' },
        mode: { type: 'STRING', description: 'up or down: for input_volume / output_volume.' },
        feature: { type: 'STRING', description: 'For audio_toggle: noise_suppression | echo_cancellation | automatic_gain_control | qos.' },
      }, required: ['action'] } });
      _bits.push('Discord voice (mute/deafen, push-to-talk, join/leave a channel by name, input/output volume, audio features)');
    }
    if (_bits.length) {
      _integrationsText = ' SMART DEVICE & MEDIA CONTROL is available for: ' + _bits.join('; ') + '.'
        + ' Use these tools whenever the user asks to control the matching thing, e.g. "metti <canzone> su Spotify"/"play <song>" → spotify_control play_song; "accendi la luce del salotto"/"turn on the living room light" → home_assistant (list first if you don\'t know the entity, then turn_on); "abbassa le luci al 30%" → home_assistant service light.turn_on with {"brightness_pct":30}; "mettimi in muto su Discord" → discord_voice mute; "entra nel canale Gaming" → discord_voice join; "fammi vedere il giardino" → home_camera show; "chi ha suonato?"/"is there a parcel?" → home_camera look; "how is the house?" → home_camera summary.'
        + ' For Home Assistant, ALWAYS call action "list" first when you are unsure of the exact entity_id, then act on the matched id. If a tool returns an "unavailable"/"not_connected" error, tell the user that integration isn\'t connected (Settings → Spotify / Casa / Discord) rather than pretending it worked.';
    }
  }
  return { streamingText: _streamingText, integrationsText: _integrationsText };
}

module.exports = { addIntegrationAiFunctions };
