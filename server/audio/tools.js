// What the assistant does when asked about sound: the microphone, the volume of the PC or of
// one app, and which speakers or microphone are in use.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const { audioCache } = require('./device-cache.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'toggle_mic': async (_context, { setMicMute }) => {
      let fnResult;
      audioCache.muted = !audioCache.muted; setMicMute(audioCache.muted);
      fnResult = { ok: true, muted: audioCache.muted };
      return fnResult;
  },

  'mute_mic': async (_context, { setMicMute }) => {
      let fnResult;
      audioCache.muted = true; setMicMute(true);
      fnResult = { ok: true, muted: true };
      return fnResult;
  },

  'unmute_mic': async (_context, { setMicMute }) => {
      let fnResult;
      audioCache.muted = false; setMicMute(false);
      fnResult = { ok: true, muted: false };
      return fnResult;
  },

  'set_volume': async ({ fnArgs }, { svvExec }) => {
      let fnResult;
      const vol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (audioCache.speakerId) {
        await svvExec(['/SetVolume', audioCache.speakerId, String(vol)]);
      }
      fnResult = { ok: true, level: vol };
      return fnResult;
  },

  'toggle_speaker_mute': async (_context, { svvExec }) => {
      let fnResult;
      if (!audioCache.speakerId) { fnResult = { error: 'audio not ready' }; }
      else {
        await svvExec(['/Switch', audioCache.speakerId]);
        fnResult = { ok: true };
      }
      return fnResult;
  },

  'set_mic_volume': async ({ fnArgs }, { svvExec }) => {
      let fnResult;
      const micVol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (!audioCache.micId) { fnResult = { error: 'mic not ready' }; }
      else {
        await svvExec(['/SetVolume', audioCache.micId, String(micVol)]);
        fnResult = { ok: true, level: micVol };
      }
      return fnResult;
  },

  'app_audio': async ({ fnArgs, runAction }) => {
      let fnResult;
      // Per-app mixer via the same allowlisted registry the Deck uses.
      const app = String(fnArgs.app || '').trim();
      const action = String(fnArgs.action || '');
      const map = {
        volume_up: { type: 'appVolume', app, mode: 'up' },
        volume_down: { type: 'appVolume', app, mode: 'down' },
        mute: { type: 'appMute', app, mode: 'mute' },
        unmute: { type: 'appMute', app, mode: 'unmute' },
        toggle_mute: { type: 'appMute', app, mode: 'toggle' },
      };
      const act = map[action];
      fnResult = !app ? { error: 'no_app' } : (act ? await runAction(act) : { error: 'bad_action' });
      return fnResult;
  },

  'list_audio_devices': async (_context, { getAudioInfo }) => {
      let fnResult;
      // Report the available output/input devices so the model can pick one by
      // name (and answer "what speakers do I have?").
      const info = await getAudioInfo().catch(() => null);
      if (!info) { fnResult = { error: 'audio_unavailable' }; }
      else {
        const trim = (arr) => (Array.isArray(arr) ? arr : []).map(d => ({ name: d.label || d.name, current: !!d.isDefault })).slice(0, 24);
        fnResult = { ok: true, speakers: trim(info.speakers), microphones: trim(info.mics),
          current: { speaker: info.speaker && (info.speaker.label || info.speaker.name) || null, microphone: info.mic && (info.mic.label || info.mic.name) || null } };
      }
      return fnResult;
  },

  'set_audio_device': async ({ fnArgs }, { getAudioInfo, setDefaultAudioDevice, setMicMute }) => {
      let fnResult;
      // Switch the default output/input device by (fuzzy) name. Reuses the exact
      // SoundVolumeView path the manual picker uses.
      const kind = String(fnArgs.kind || '').toLowerCase();
      const wanted = String(fnArgs.name || '').trim().toLowerCase();
      if (!['speaker', 'mic', 'microphone'].includes(kind)) { fnResult = { error: 'bad_kind', message: 'kind must be "speaker" or "mic"' }; }
      else if (!wanted) { fnResult = { error: 'no_name' }; }
      else {
        const info = await getAudioInfo().catch(() => null);
        const list = info ? (kind === 'speaker' ? info.speakers : info.mics) : null;
        if (!Array.isArray(list) || !list.length) { fnResult = { error: 'audio_unavailable' }; }
        else {
          const hay = (d) => `${d.label || ''} ${d.name || ''}`.toLowerCase();
          const match = list.find(d => hay(d) === wanted)
            || list.find(d => hay(d).includes(wanted))
            || list.find(d => wanted.includes((d.name || '').toLowerCase()) && (d.name || '').length > 2);
          if (!match || !match.id) {
            fnResult = { error: 'not_found', available: list.map(d => d.label || d.name).slice(0, 24) };
          } else {
            await setDefaultAudioDevice(match.id);
            if (kind === 'speaker') audioCache.speakerId = match.id;
            else { audioCache.micId = match.id; if (audioCache.muted) setMicMute(true); }
            fnResult = { ok: true, kind: kind === 'speaker' ? 'speaker' : 'microphone', device: match.label || match.name };
          }
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
