// The tools the assistant always has for the microphone, what is playing, the volume and the
// computer itself.

function pcAiFunctions() {
  return [
        // ── Microphone ──
        { name: 'toggle_mic', description: 'Toggle microphone mute/unmute', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'mute_mic', description: 'Mute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'unmute_mic', description: 'Unmute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        // ── Media ──
        { name: 'media_playpause', description: 'Play or pause current media playback', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_next', description: 'Skip to the next track', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_previous', description: 'Go to the previous track', parameters: { type: 'OBJECT', properties: {} } },
        // ── Volume / Audio ──
        { name: 'set_volume', description: 'Set master speaker volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Volume level 0-100' } }, required: ['level'] } },
        { name: 'toggle_speaker_mute', description: 'Toggle the speaker/audio output mute on or off', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_mic_volume', description: 'Set microphone input volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Mic volume 0-100' } }, required: ['level'] } },
        { name: 'app_audio', description: 'Adjust the audio of a SPECIFIC running application (per-app mixer): turn one app up or down, or mute/unmute it, without touching the master volume. e.g. "lower Spotify", "mute Chrome".', parameters: { type: 'OBJECT', properties: {
          app: { type: 'STRING', description: 'The application name or process, e.g. "Spotify", "chrome", "Discord"' },
          action: { type: 'STRING', description: 'One of: volume_up, volume_down, mute, unmute, toggle_mute' },
        }, required: ['app', 'action'] } },
        // ── System ──
        { name: 'lock_pc', description: 'Lock the computer: its normal lock screen, the user logs back in', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_system_info', description: 'Get current CPU, GPU, RAM and disk usage stats, plus fan speeds (fans[]) and power draw in watts (power.cpu/gpu/psu/total)', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_battery_status', description: 'Get the battery level of the user\'s wireless peripherals (mouse, keyboard, headset: Corsair via iCUE, Bluetooth devices, and mice, keyboards, headsets and controllers of many brands on their USB dongle; a device with no known protocol is not listed; if the result has access, the OS must allow the read first: say what it needs, on Linux the access.command line). A device with lastReadMinutesAgo is asleep or off: its percent is that old, say so. Two of one model read "Name" and "Name (2)". Each device has kind (mouse, keyboard, headset, controller, system, ups, other or unknown) from what the hardware declares: answer "my mouse" with the kind mouse, not by guessing from the name; unknown means the hardware did not say. Use for "how\'s my mouse battery", "batteria del mouse".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_energy_status', description: 'Get the full energy picture: the PC\'s power draw in watts (CPU/GPU/PSU) plus the user\'s Home Assistant power/energy readings (solar production, smart plugs, home meter, UPS). Use for "how much power is the PC using", "quanto sta producendo il fotovoltaico", "consumo di casa".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_weather', description: 'Get current weather conditions and forecast', parameters: { type: 'OBJECT', properties: {} } },
  ];
}

module.exports = { pcAiFunctions };
