'use strict';
// Typed-action catalog (metadata only) + validator for the Deck widget. Shared
// by the editor (browser, window.DeckActions) and — in a later phase — the
// server action registry (require). No DOM, no execution here.
//
// param.kind: 'text' | 'path' | 'url' | 'select' (select carries `options`) |
//             'audioApp' | 'storeApp' | 'obsScene' | 'obsSource' | 'sbAction' |
//             'sbCodeTrigger' | 'discordChannel' | 'haEntity' (picker controls).

const ACTION_CATALOG = [
  { type: 'openApp',  group: 'system', labelKey: 'deck_act_openApp',  params: [{ name: 'path', kind: 'path' }] },
  { type: 'openFile', group: 'system', labelKey: 'deck_act_openFile', params: [{ name: 'path', kind: 'path' }] },
  { type: 'openStoreApp', group: 'system', labelKey: 'deck_act_openStoreApp', params: [{ name: 'appId', kind: 'storeApp' }] },
  { type: 'openUrl',  group: 'system', labelKey: 'deck_act_openUrl',  params: [{ name: 'url',  kind: 'url'  }] },
  { type: 'hotkey',   group: 'system', labelKey: 'deck_act_hotkey',   params: [{ name: 'keys', kind: 'text' }] },
  { type: 'webhook',  group: 'system', labelKey: 'deck_act_webhook',  params: [{ name: 'url', kind: 'url' }, { name: 'method', kind: 'select', options: ['GET', 'POST'] }, { name: 'body', kind: 'text' }] },
  { type: 'media',    group: 'media',  labelKey: 'deck_act_media',    params: [{ name: 'cmd',  kind: 'select', options: ['playpause', 'next', 'previous'] }] },
  { type: 'playSound', group: 'media', labelKey: 'deck_act_playSound', params: [{ name: 'file', kind: 'path' }, { name: 'mode', kind: 'select', options: ['play', 'toggle', 'stop'] }] },
  { type: 'micMute',  group: 'audio',  labelKey: 'deck_act_micMute',  params: [{ name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'volume',   group: 'audio',  labelKey: 'deck_act_volume',   params: [{ name: 'mode', kind: 'select', options: ['mute', 'up', 'down'] }] },
  { type: 'appVolume', group: 'audio', labelKey: 'deck_act_appVolume', params: [{ name: 'app', kind: 'audioApp' }, { name: 'mode', kind: 'select', options: ['up', 'down'] }] },
  { type: 'appMute',   group: 'audio', labelKey: 'deck_act_appMute',   params: [{ name: 'app', kind: 'audioApp' }, { name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'appMixer',  group: 'audio', labelKey: 'deck_act_appMixer',  params: [] },
  { type: 'obsScene',  group: 'obs', labelKey: 'deck_act_obsScene',  params: [{ name: 'scene',  kind: 'obsScene' }] },
  { type: 'obsSceneNext', group: 'obs', labelKey: 'deck_act_obsSceneNext', params: [] },
  { type: 'obsRecord', group: 'obs', labelKey: 'deck_act_obsRecord', params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] }] },
  { type: 'obsStream', group: 'obs', labelKey: 'deck_act_obsStream', params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] }] },
  { type: 'obsMute',   group: 'obs', labelKey: 'deck_act_obsMute',   params: [{ name: 'source', kind: 'obsSource' }, { name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'twitchClip',   group: 'stream', labelKey: 'deck_act_twitchClip',   params: [] },
  { type: 'twitchMarker', group: 'stream', labelKey: 'deck_act_twitchMarker', params: [{ name: 'description', kind: 'text' }] },
  { type: 'twitchAd',     group: 'stream', labelKey: 'deck_act_twitchAd',     params: [{ name: 'length', kind: 'select', options: ['30', '60', '90', '120', '150', '180'] }] },
  { type: 'twitchTitle',  group: 'stream', labelKey: 'deck_act_twitchTitle',  params: [{ name: 'title', kind: 'text' }] },
  { type: 'twitchGame',   group: 'stream', labelKey: 'deck_act_twitchGame',   params: [{ name: 'game', kind: 'text' }] },
  { type: 'twitchChat',   group: 'stream', labelKey: 'deck_act_twitchChat',   params: [{ name: 'message', kind: 'text' }] },
  { type: 'twitchShoutout', group: 'stream', labelKey: 'deck_act_twitchShoutout', params: [{ name: 'login', kind: 'text' }] },
  { type: 'twitchChatMode', group: 'stream', labelKey: 'deck_act_twitchChatMode', params: [{ name: 'mode', kind: 'select', options: ['emoteonly', 'followers', 'subscribers', 'slow', 'off'] }] },
  { type: 'ytBroadcast',  group: 'stream', labelKey: 'deck_act_ytBroadcast',  params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] }] },
  { type: 'sbDoAction', group: 'streamerbot', labelKey: 'deck_act_sbDoAction', params: [{ name: 'action', kind: 'sbAction' }, { name: 'args', kind: 'text' }] },
  { type: 'sbSendMessage', group: 'streamerbot', labelKey: 'deck_act_sbSendMessage', params: [{ name: 'platform', kind: 'select', options: ['twitch', 'youtube', 'kick', 'trovo'] }, { name: 'message', kind: 'text' }, { name: 'sendAs', kind: 'select', options: ['bot', 'broadcaster'] }] },
  { type: 'sbCodeTrigger', group: 'streamerbot', labelKey: 'deck_act_sbCodeTrigger', params: [{ name: 'trigger', kind: 'sbCodeTrigger' }, { name: 'args', kind: 'text' }] },
  { type: 'discordMute',        group: 'discord', labelKey: 'deck_act_discordMute',        params: [{ name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'discordDeafen',      group: 'discord', labelKey: 'deck_act_discordDeafen',      params: [{ name: 'mode', kind: 'select', options: ['toggle', 'deafen', 'undeafen'] }] },
  { type: 'discordPtt',         group: 'discord', labelKey: 'deck_act_discordPtt',         params: [{ name: 'mode', kind: 'select', options: ['toggle', 'ptt', 'vad'] }] },
  { type: 'discordJoin',        group: 'discord', labelKey: 'deck_act_discordJoin',        params: [{ name: 'channel', kind: 'discordChannel' }] },
  { type: 'discordLeave',       group: 'discord', labelKey: 'deck_act_discordLeave',       params: [] },
  { type: 'discordInputVol',    group: 'discord', labelKey: 'deck_act_discordInputVol',    params: [{ name: 'mode', kind: 'select', options: ['up', 'down'] }] },
  { type: 'discordOutputVol',   group: 'discord', labelKey: 'deck_act_discordOutputVol',   params: [{ name: 'mode', kind: 'select', options: ['up', 'down'] }] },
  { type: 'discordAudioToggle', group: 'discord', labelKey: 'deck_act_discordAudioToggle', params: [{ name: 'feature', kind: 'select', options: ['noise_suppression', 'echo_cancellation', 'automatic_gain_control', 'qos'] }] },
  { type: 'spotifyPlay',     group: 'spotify', labelKey: 'deck_act_spotifyPlay',     params: [{ name: 'mode', kind: 'select', options: ['toggle', 'play', 'pause'] }] },
  { type: 'spotifyNext',     group: 'spotify', labelKey: 'deck_act_spotifyNext',     params: [] },
  { type: 'spotifyPrev',     group: 'spotify', labelKey: 'deck_act_spotifyPrev',     params: [] },
  { type: 'spotifySave',     group: 'spotify', labelKey: 'deck_act_spotifySave',     params: [] },
  { type: 'spotifyLike',     group: 'spotify', labelKey: 'deck_act_spotifyLike',     params: [{ name: 'mode', kind: 'select', options: ['toggle', 'like', 'unlike'] }] },
  { type: 'spotifyShuffle',  group: 'spotify', labelKey: 'deck_act_spotifyShuffle',  params: [{ name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] }] },
  { type: 'spotifyRepeat',   group: 'spotify', labelKey: 'deck_act_spotifyRepeat',   params: [{ name: 'mode', kind: 'select', options: ['toggle', 'off', 'context', 'track'] }] },
  { type: 'spotifyVolume',   group: 'spotify', labelKey: 'deck_act_spotifyVolume',   params: [{ name: 'mode', kind: 'select', options: ['up', 'down', 'set'] }, { name: 'value', kind: 'text' }] },
  { type: 'spotifySeek',     group: 'spotify', labelKey: 'deck_act_spotifySeek',     params: [{ name: 'value', kind: 'text' }] },
  { type: 'spotifyPlaylist', group: 'spotify', labelKey: 'deck_act_spotifyPlaylist', params: [{ name: 'playlist', kind: 'text' }] },
  { type: 'spotifyDevice',   group: 'spotify', labelKey: 'deck_act_spotifyDevice',   params: [{ name: 'device', kind: 'text' }] },
  { type: 'haToggle',      group: 'homeassistant', labelKey: 'deck_act_haToggle',      params: [{ name: 'entity', kind: 'haEntity' }, { name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] }] },
  { type: 'haLight',       group: 'homeassistant', labelKey: 'deck_act_haLight',       params: [{ name: 'entity', kind: 'haEntity', domain: 'light' }, { name: 'mode', kind: 'select', options: ['toggle', 'on', 'off', 'brighter', 'dimmer'] }] },
  { type: 'haMedia',       group: 'homeassistant', labelKey: 'deck_act_haMedia',       params: [{ name: 'entity', kind: 'haEntity', domain: 'media_player' }, { name: 'cmd', kind: 'select', options: ['playpause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute', 'unmute'] }] },
  { type: 'haCover',       group: 'homeassistant', labelKey: 'deck_act_haCover',       params: [{ name: 'entity', kind: 'haEntity', domain: 'cover' }, { name: 'cmd', kind: 'select', options: ['open', 'close', 'stop', 'toggle'] }] },
  { type: 'haClimate',     group: 'homeassistant', labelKey: 'deck_act_haClimate',     params: [{ name: 'entity', kind: 'haEntity', domain: 'climate' }, { name: 'mode', kind: 'select', options: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'] }] },
  { type: 'haFan',         group: 'homeassistant', labelKey: 'deck_act_haFan',         params: [{ name: 'entity', kind: 'haEntity', domain: 'fan' }, { name: 'mode', kind: 'select', options: ['toggle', 'on', 'off'] }] },
  { type: 'haVacuum',      group: 'homeassistant', labelKey: 'deck_act_haVacuum',      params: [{ name: 'entity', kind: 'haEntity', domain: 'vacuum' }, { name: 'cmd', kind: 'select', options: ['start', 'pause', 'stop', 'return', 'locate'] }] },
  { type: 'haLock',        group: 'homeassistant', labelKey: 'deck_act_haLock',        params: [{ name: 'entity', kind: 'haEntity', domain: 'lock' }, { name: 'mode', kind: 'select', options: ['lock', 'unlock'] }] },
  { type: 'haAlarm',       group: 'homeassistant', labelKey: 'deck_act_haAlarm',       params: [{ name: 'entity', kind: 'haEntity', domain: 'alarm_control_panel' }, { name: 'mode', kind: 'select', options: ['disarm', 'arm_home', 'arm_away', 'arm_night'] }, { name: 'code', kind: 'text' }] },
  { type: 'haScene',       group: 'homeassistant', labelKey: 'deck_act_haScene',       params: [{ name: 'entity', kind: 'haEntity', domain: 'scene' }] },
  { type: 'haScript',      group: 'homeassistant', labelKey: 'deck_act_haScript',      params: [{ name: 'entity', kind: 'haEntity', domain: 'script' }] },
  { type: 'haButton',      group: 'homeassistant', labelKey: 'deck_act_haButton',      params: [{ name: 'entity', kind: 'haEntity', domain: 'button' }] },
  { type: 'haCallService', group: 'homeassistant', labelKey: 'deck_act_haCallService', params: [{ name: 'service', kind: 'text' }, { name: 'entity', kind: 'text' }, { name: 'data', kind: 'text' }] },
  { type: 'windowMove',    group: 'window', labelKey: 'deck_act_windowMove', params: [{ name: 'dir', kind: 'select', options: ['next-monitor', 'prev-monitor', 'left', 'right', 'maximize', 'minimize', 'center'] }] },
  { type: 'remoteDisconnect',  group: 'remote', labelKey: 'deck_act_remoteDisconnect',  params: [] },
  { type: 'remoteBlock',       group: 'remote', labelKey: 'deck_act_remoteBlock',       params: [{ name: 'mode', kind: 'select', options: ['toggle', 'block', 'unblock'] }] },
  { type: 'remoteScreenCycle', group: 'remote', labelKey: 'deck_act_remoteScreenCycle', params: [] },
  { type: 'ai', group: 'ai', labelKey: 'deck_act_ai', params: [{ name: 'mode', kind: 'select', options: ['prompt', 'voice', 'open'] }, { name: 'prompt', kind: 'text' }] },
  { type: 'lighting', group: 'lighting', hidden: true, labelKey: 'deck_act_lighting', params: [{ name: 'mode', kind: 'select', options: ['set', 'restore'] }, { name: 'color', kind: 'text' }, { name: 'style', kind: 'select', options: ['solid', 'breathing', 'cycle'] }] },
];

function actionSpec(type) {
  return ACTION_CATALOG.find(a => a.type === type) || null;
}

// Return a clean action with ONLY the params its spec allows, or null if the
// type is unknown. select → coerced to a valid option; text/url/path → string,
// capped. This is the single source of truth the server registry will reuse.
function validateAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const spec = actionSpec(raw.type);
  if (!spec) return null;
  const out = { type: spec.type };
  for (const p of spec.params) {
    let v = raw[p.name];
    if (p.kind === 'select') {
      v = (typeof v === 'string' && p.options.includes(v)) ? v : p.options[0];
    } else {
      v = String(v == null ? '' : v).slice(0, 1024);
    }
    out[p.name] = v;
  }
  return out;
}

function clampDelay(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10000, n));
}

// Canonicalise a trigger (a single Action, or a Multi-Action {steps:[...]}) into
// an ordered list of validated [{action, delayMs}]. Invalid steps are dropped.
function triggerSteps(trigger) {
  if (!trigger || typeof trigger !== 'object') return [];
  if (Array.isArray(trigger.steps)) {
    const out = [];
    for (const s of trigger.steps) {
      const action = validateAction(s && s.action);
      if (action) out.push({ action, delayMs: clampDelay(s && s.delayMs) });
    }
    return out;
  }
  const action = validateAction(trigger);
  return action ? [{ action, delayMs: 0 }] : [];
}

// Inverse of triggerSteps: turn a list of {action, delayMs} into the smallest
// valid trigger value — null if empty, a bare Action for one zero-delay step,
// else { steps:[...] }. Invalid steps are dropped (validated).
function compactTrigger(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (const s of list) {
    const action = validateAction(s && s.action);
    if (action) out.push({ action, delayMs: clampDelay(s && s.delayMs) });
  }
  if (!out.length) return null;
  if (out.length === 1 && !out[0].delayMs) return out[0].action;
  return { steps: out };
}

if (typeof window !== 'undefined') {
  window.DeckActions = { ACTION_CATALOG, actionSpec, validateAction, triggerSteps, clampDelay, compactTrigger };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ACTION_CATALOG, actionSpec, validateAction, triggerSteps, clampDelay, compactTrigger };
}
