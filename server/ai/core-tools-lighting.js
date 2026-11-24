// The tools the assistant always has for the RGB lights.

const LightFx = require('../js/light-fx/light-fx.js');

// The effects of Settings -> Lighting by group, from the one list of light effects
// (js/light-fx/light-fx.js), with what the ones that follow the PC read.
const FOLLOWS = { sound: 'the sound the PC plays', load: 'how hard the PC works', fans: 'the fan speeds', sky: 'sunrise and sunset', weather: 'the weather outside', timer: 'a running Xenon timer' };
const EFFECTS = LightFx.GROUPS.map((group) => group + ': ' + LightFx.LIST.filter((e) => LightFx.LIGHTING.includes(e.id) && e.group === group)
  .map((e) => (FOLLOWS[e.needs] ? `${e.id} (${FOLLOWS[e.needs]})` : e.id)).join(', ')).join('; ');
const OLD = Object.keys(LightFx.OLD_LIGHTING).filter((s) => !LightFx.LIGHTING.includes(s)).join(', ');

function lightingAiFunctions() {
  return [
        // ── RGB Lighting (Corsair / iCUE bridge) ──
        { name: 'set_lights', description: 'Set a manual RGB colour on all the lighting Xenon drives: Corsair through iCUE and every other device set up in Settings → Lighting (overrides reactive effects until cleared; for one device or one part use run_deck_action lightDevice/lightPart, for Razer Chroma chromaColor). Accepts a colour name (EN or IT, e.g. "red"/"rosso") or a #RRGGBB hex. Use "off"/"spento" to turn them dark.', parameters: { type: 'OBJECT', properties: {
          color: { type: 'STRING', description: 'Colour name or #RRGGBB, e.g. "red", "rosso", "#00ff88", "off"' },
        }, required: ['color'] } },
        { name: 'clear_lights', description: 'Clear the manual colour override so reactive effects (CPU temperature, album colour, event flashes) resume.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_effect', description: 'Enable or disable a lighting effect: temperature (CPU temp → colour), musicAlbum (album cover → LEDs), timer, notification, reminder.', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: temperature, musicAlbum, timer, notification, reminder' },
          enabled: { type: 'BOOLEAN', description: 'true to enable, false to disable' },
        }, required: ['effect', 'enabled'] } },
        { name: 'set_event_effect', description: 'Configure an event flash effect (timer, notification, reminder): its colour and animation style, and optionally enable it.', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: timer, notification, reminder' },
          color: { type: 'STRING', description: 'Colour name or #RRGGBB (e.g. "red", "rosso", "#00ff88")' },
          style: { type: 'STRING', description: 'Animation style: blink, pulse, or solid' },
          enabled: { type: 'BOOLEAN', description: 'Optional: enable/disable the effect' },
        }, required: ['effect'] } },
        { name: 'set_animation', description: `Set the effect of every light Xenon drives (Settings -> Lighting), drawn LED by LED on each fan, pump ring, strip and keyboard. Effects, ${EFFECTS}. none = no effect. The names ${OLD} still work as saved before. The lighting master must be on for it to show (use set_lighting_bridge).`, parameters: { type: 'OBJECT', properties: {
          style: { type: 'STRING', description: 'One effect id from the list, or none' },
          color: { type: 'STRING', description: 'Optional: one colour name or #RRGGBB, the effect\'s only colour' },
          palette: { type: 'STRING', description: 'Optional: 1-5 comma-separated colours the effect uses, e.g. "#ff0000,#0000ff" or "rosso,blu,verde"; rainbow keeps its own' },
          speed: { type: 'NUMBER', description: 'Optional speed 1-100 (50 as made, higher = faster)' },
          reverse: { type: 'BOOLEAN', description: 'Optional: run it the other way' },
          size: { type: 'NUMBER', description: 'Optional 0-1: the effect\'s own amount (a comet\'s tail, the drops, the stars, the beam)' },
          glow: { type: 'NUMBER', description: 'Optional 0-1: how lit the dark part stays' },
          chain: { type: 'BOOLEAN', description: 'Optional: true runs the fans and strips one after another instead of together' },
        } } },
        { name: 'set_lighting_bridge', description: 'Turn the whole RGB lighting bridge on or off (master switch). When off, control returns to iCUE and the board, which show their own lighting; pass dark:true when the user wants the lights switched OFF.', parameters: { type: 'OBJECT', properties: {
          enabled: { type: 'BOOLEAN', description: 'true to enable the bridge, false to disable' },
          dark: { type: 'BOOLEAN', description: 'with enabled:false, every light goes dark (black) instead of going back to iCUE/the board. Use it for "switch the lights off".' },
        }, required: ['enabled'] } },
        { name: 'show_sensor', description: 'Read a current sensor value to report to the user (e.g. CPU temperature, fan speed, power draw).', parameters: { type: 'OBJECT', properties: {
          sensor: { type: 'STRING', description: 'Sensor to read: cpuTemp, gpuTemp, cpu, gpu, cpuFan, gpuFan, cpuWatts, gpuWatts, totalWatts, psuWatts' },
        }, required: ['sensor'] } },
        { name: 'go_to_page', description: 'Show a page of the dashboard: by the name the user gave it, by its number, or the next/previous one.', parameters: { type: 'OBJECT', properties: {
          page: { type: 'STRING', description: 'The page as the user names it: its name (e.g. "Streaming"), its number ("2"), "next" or "prev". When no page has that name the reply lists the real names.' },
        }, required: ['page'] } },
        { name: 'switch_deck_profile', description: 'Switch the Deck widget (a Stream Deck-style key grid) to one of its profiles. Use the EXACT profile name from the list of available deck profiles given in the system context. Only call this when the user asks to change/switch the deck profile.', parameters: { type: 'OBJECT', properties: {
          profile: { type: 'STRING', description: 'The exact name of the deck profile to activate' },
        }, required: ['profile'] } },
  ];
}

module.exports = { lightingAiFunctions };
