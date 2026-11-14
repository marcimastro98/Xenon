'use strict';
// macOS sound as the rows the volume mixer draws: the volume settings and the devices
// system_profiler lists, with stand-ins while the list is read.

// --- Audio: osascript + system_profiler, shaped as SoundVolumeView rows ------
// SoundVolumeView /scomma column indices (see the F.* map in server.js).
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// `get volume settings` -> "output volume:50, input volume:75, alert volume:100,
// output muted:false". Missing values print as "missing value".
function parseVolumeSettings(out) {
  const num = (key) => {
    const m = String(out || '').match(new RegExp(key + ':\\s*(\\d+)'));
    return m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
  };
  const muted = /output muted:\s*true/i.test(String(out || ''));
  return { output: num('output volume'), input: num('input volume'), muted };
}

// system_profiler's audio tree: one entry per device, with the default flags on
// the device itself. Names are the only durable identifier macOS exposes to a
// shell, so the name doubles as the row's id.
function parseAudioDevices(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return { outputs: [], inputs: [] }; }
  const roots = doc && Array.isArray(doc.SPAudioDataType) ? doc.SPAudioDataType : [];
  const outputs = [];
  const inputs = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n._items)) walk(n._items);
      const name = String(n._name || '').trim();
      if (!name) continue;
      const isOut = n.coreaudio_device_output === 'spaudio_yes' ||
                    n.coreaudio_default_audio_output_device === 'spaudio_yes' ||
                    n.coreaudio_default_audio_system_device === 'spaudio_yes';
      const isIn = n.coreaudio_device_input === 'spaudio_yes' ||
                   n.coreaudio_default_audio_input_device === 'spaudio_yes';
      if (isOut) {
        outputs.push({ name, isDefault: n.coreaudio_default_audio_output_device === 'spaudio_yes' });
      }
      if (isIn) {
        inputs.push({ name, isDefault: n.coreaudio_default_audio_input_device === 'spaudio_yes' });
      }
    }
  };
  walk(roots);
  return { outputs, inputs };
}

// Device names change only when hardware is plugged or unplugged, and
// system_profiler costs about a second, so this is cached far longer than the
// volume read that rides on top of it.
const AUDIO_DEVICES_TTL_MS = 30000;

// When system_profiler is unavailable or denied, the enumeration comes back
// empty and the mixer still has to show the two devices the volume read proves
// are there. These stand-in names are what the rows carry, so every consumer
// must resolve a device list through here — a writer that classified a target
// against the RAW list would not recognise "Microphone" as an input and would
// send a mic mute to the speakers instead.
const PLACEHOLDER_OUTPUT = 'Output';
const PLACEHOLDER_INPUT = 'Microphone';
function withPlaceholders(devices) {
  const d = devices || { outputs: [], inputs: [] };
  return {
    outputs: d.outputs && d.outputs.length ? d.outputs : [{ name: PLACEHOLDER_OUTPUT, isDefault: true }],
    inputs: d.inputs && d.inputs.length ? d.inputs : [{ name: PLACEHOLDER_INPUT, isDefault: true }],
  };
}

// Build rows matching SoundVolumeView's /scomma layout.
// Application rows are deliberately absent: see the header note.
function buildAudioRows(devices, vol) {
  const rows = [];
  const row = () => new Array(22).fill('');
  const add = (name, dir, isDefault, volume, muted) => {
    const r = row();
    r[F.NAME] = name;
    r[F.TYPE] = 'Device';
    r[F.DIR] = dir; // Render | Capture
    r[F.DEVICE_NAME] = name;
    r[F.DEFAULT] = isDefault ? dir : '';
    r[F.STATE] = 'Active';
    r[F.MUTED] = muted ? 'Yes' : 'No';
    r[F.VOL_PCT] = String(volume == null ? '' : volume);
    r[F.CLI_ID] = name; // the name is the only shell-visible device identifier
    rows.push(r);
  };

  const { outputs: outs, inputs: ins } = withPlaceholders(devices);
  // Only the default device's level is knowable from a shell, so the others
  // report an empty volume rather than a number copied from somewhere else.
  outs.forEach((d) => add(d.name, 'Render', d.isDefault, d.isDefault ? vol.output : null, d.isDefault ? vol.muted : false));
  ins.forEach((d) => add(d.name, 'Capture', d.isDefault, d.isDefault ? vol.input : null, d.isDefault ? vol.input === 0 : false));
  return rows;
}

// Which output is the default RIGHT NOW. system_profiler knows too, but costs
// about a second and is cached for 30s above, so a switch made from the menu
// bar reached the dashboard (and an Output device Deck key's face) up to half a
// minute late. SwitchAudioSource, the tool output switching already needs,
// answers in milliseconds. Without it nothing changes: the cached answer stands.
// A missing tool is remembered for a while rather than spawned every poll.
const SAS_MISSING_RETRY_MS = 5 * 60 * 1000;

// Pure: the device list with its default taken from `current`, when `current`
// is one of the listed outputs. Anything else (no answer, a name the list does
// not have) leaves the list exactly as system_profiler reported it.
function withCurrentOutput(devices, current) {
  const d = devices || { outputs: [], inputs: [] };
  const name = typeof current === 'string' ? current.trim() : '';
  if (!name || !Array.isArray(d.outputs) || !d.outputs.some((o) => o && o.name === name)) return d;
  return Object.assign({}, d, { outputs: d.outputs.map((o) => Object.assign({}, o, { isDefault: o.name === name })) });
}

const AUDIO_ROWS_TTL_MS = 900;

// Is this write aimed at the capture side? Targets arrive as a device name, as
// SoundVolumeView's default selectors, or as "<binary>.exe" for a per-app write.
// `devices` must already carry the placeholders, because the name the caller
// holds came from a row built with them.
function isCaptureTarget(target, devices) {
  const t = String(target || '').trim();
  if (t === 'DefaultCaptureDevice') return true;
  if (t === 'DefaultRenderDevice') return false;
  const d = withPlaceholders(devices);
  return d.inputs.some((x) => x.name === t) && !d.outputs.some((x) => x.name === t);
}

// Cheap capability probe for /actions: can we read the system volume at all?
// A YES is cached forever, a NO only for a cooldown — a probe that loses a
// race at login (session services still coming up) must not hide the audio
// Deck keys for the whole uptime. Same rule as the Linux twin.
const AUDIO_PROBE_RETRY_MS = 60000;

module.exports = {
  F, parseVolumeSettings, parseAudioDevices, AUDIO_DEVICES_TTL_MS, PLACEHOLDER_OUTPUT,
  PLACEHOLDER_INPUT, withPlaceholders, buildAudioRows, SAS_MISSING_RETRY_MS, withCurrentOutput,
  AUDIO_ROWS_TTL_MS, isCaptureTarget, AUDIO_PROBE_RETRY_MS,
};
