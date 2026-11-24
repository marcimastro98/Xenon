'use strict';
// Pump screens (server/pump-screen/): the LCD on an AIO pump, shown through iCUE's
// widget, NZXT CAM or as a small monitor. The Xenon menu, a Deck key and Bit change
// it through these entries, so the one rule set in js/pump/pump-model.js holds for
// all of them. Same shape as capability-catalog.js, which appends them; the page
// loads this file just before it.
((root, factory) => {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('../light-fx/light-fx.js') : root.LightFx);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapabilityCatalogPump = api;
})(typeof window !== 'undefined' ? window : globalThis, (Fx) => {
  const SCREEN = { name: 'screen', kind: 'text', maxLen: 24, optional: true, labelKey: 'deck_param_pump_screen' };
  const FACES = ['auto', 'next', 'sensors', 'game', 'music', 'clock', 'picture'];
  const SETUPS = ['game', 'music', 'picture', 'clock', 'monitor'];
  const STYLES = ['next', 'xenon', 'gauge'];
  const keys = (list, prefix) => Object.fromEntries(list.map((v) => [v, prefix + v]));
  // How the ring of lights can move, in Bit's words, from the one list of light effects
  // (js/light-fx/light-fx.js; a page that has not loaded it gets the short form).
  const NEEDS = {
    sound: 'reads the sound the PC plays, Windows', level: "the line's first reading or the song's time",
    load: 'how hard the CPU and GPU work', fans: 'the fan speeds Xenon reads', sky: 'sunrise and sunset where the weather is set',
    weather: 'the weather where it is set', timer: 'a running Xenon timer', time: null,
  };
  const PALETTES = Fx ? Fx.PALETTE_IDS.join(', ') : 'sunset, ocean, neon...';
  const RING = !Fx ? 'one of the light effects (still, breathe, spin, comet, rainbow...)' : Fx.GROUPS.map((group) => group + ': '
    + Fx.LIST.filter((e) => e.group === group).map((e) => `${e.id} (${e.about.replace(/.$/, '')}${NEEDS[e.needs] ? '; ' + NEEDS[e.needs] : ''})`).join(', ')).join('; ');

  const CAPABILITIES = [
    {
      type: 'pumpFace', group: 'xenon', labelKey: 'deck_act_pumpFace',
      params: [
        { name: 'face', kind: 'select', options: FACES, optionKeys: keys(FACES, 'pump_face_') },
        { name: 'minutes', kind: 'select', options: ['0', '1', '5', '15', '60'], optionKeys: keys(['0', '1', '5', '15', '60'], 'pump_for_'), labelKey: 'deck_param_pump_for' },
        SCREEN,
      ],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpScreen',
        ai: {
          name: 'show_on_pump',
          description: 'Show one face on the pump\'s screen now (the LCD on an AIO cooler pump): sensors, game (FPS and temperatures), music, clock or picture; "next" goes to the following one; "auto" lets the screen change by itself again (its moments: game when playing, music when listening). minutes keeps the face that long, 0 until "auto". screen is the pump\'s name when there are several (get_pump_screen lists them). Use it for "show the clock on my pump", "put the music on the pump for 5 minutes", "pump back to normal".',
          params: { face: 'auto, next, sensors, game, music, clock or picture', minutes: '0, 1, 5, 15 or 60', screen: 'Optional: which pump screen' },
        },
      },
    },
    {
      type: 'pumpSetup', group: 'xenon', labelKey: 'deck_act_pumpSetup',
      params: [{ name: 'setup', kind: 'select', options: SETUPS, optionKeys: keys(SETUPS, 'pump_setup_') }, SCREEN],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpScreen',
        ai: {
          name: 'set_pump_setup',
          description: 'Give the pump\'s screen a ready-made setup in one go, which sets its normal face, its moments and its lights: game (sensors on a drop; the game face while playing, music while listening), music (a clock; a turning record while music plays), picture (a moving picture; music pulse while listening), clock (a clock with hands) or monitor (four sensor bars). Mounting, name and alerts stay. Use it for "set my pump up for gaming", "make the pump a clock". For anything more precise use set_pump_screen.',
          params: { setup: 'game, music, picture, clock or monitor', screen: 'Optional: which pump screen' },
        },
      },
    },
    {
      type: 'pumpStyle', group: 'xenon', labelKey: 'deck_act_pumpStyle',
      params: [{ name: 'style', kind: 'select', options: STYLES, optionKeys: keys(STYLES, 'pump_style_') }, SCREEN],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpScreen',
        ai: {
          name: 'set_pump_style',
          description: 'Change how the pump\'s screen draws its readings, game, music and clock lines: xenon (its own faces, the default), gauge (an instrument with a needle) or next (the following one, the Store styles installed for that pump included, then back to xenon). Pictures and widget faces stay as they are. Use it for "change the pump style", "next pump style", "make the pump a gauge again". To pick one Store style by its id use set_pump_screen {"style":"widget:<id>"}.',
          params: { style: 'next, xenon or gauge', screen: 'Optional: which pump screen' },
        },
      },
    },
    // The menu's switches and Bit's detailed changes: one patch, never a Deck key.
    {
      type: 'pumpSet', group: 'xenon', hidden: true, labelKey: 'deck_act_pumpSet',
      params: [{ name: 'patch', kind: 'text', maxLen: 4000 }, SCREEN],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpScreen',
        ai: {
          name: 'set_pump_screen',
          description: 'Change how the pump\'s screen behaves, in detail. patch is JSON with any of: '
            + 'base (the face shown normally: {"face":"sensors","style":"rings (a drop that breathes, the first reading large on it)|bars|numbers","readings":[up to 4 of cpuTemp,cpu,gpuTemp,gpu,ram,vram,power,fps,cpuClock,gpuClock]} | {"face":"game","readings":[...],"track":true} | {"face":"music","style":"cover|vinyl|pulse"} | {"face":"clock","style":"digital|analog","seconds":false,"date":true,"weather":true} | {"face":"picture","items":["art:aurora|art:ember|art:tide|art:orbit" or "/uploads/<file>" from the user\'s uploads; for a file of theirs not uploaded yet call choose_pump_picture],"every":5|10|30|60|300,"fit":"cover|contain"} | {"face":"widget","id":"<an id from get_pump_screen widgets>"}: a Store widget made for a pump, which runs with the permissions the user gave it). '
            + 'Any face, in base or a moment, also takes its own look: "colors" (live = the default: each colour follows its reading, from cool blue through green and amber to red as it works harder, a clock takes the light of the hour, music and a picture their own colours; xenon = Xenon\'s fixed colours; theme, picture = the colours of the cover or picture on show, fire, ice, violet, mono, or four colours the user picks ["#main","#second","#tooHot","#background"], e.g. ["#ff0044","#ffd166","#ff3b30","#0a0a12"]: main = the drop, hands and glow, second = the second reading, tooHot = a reading too hot, background = behind the face, light ones turn the words dark), "bg" (black, glow, art:aurora|art:ember|art:tide|art:orbit, or "/uploads/<file>": behind sensors, game and clock; on the drop of the xenon style the glow spills round it and a picture shows round it and through it), "size" (normal|big: the numbers), "units" (auto|c|f: its temperatures), "warn" (false: warm readings keep their colour), "text" (words of the user on it, up to 24 characters), "leds" (how the ring of lights around the pump moves while this line shows, in its colours: auto = as the move of the leds of the screen, or one of ' + RING + '); a widget face takes colors, size, units and leds and uses the first three if made to. Another face on the same line keeps its look; "live", "black", "normal", "auto", true and "" put a field back (leds "still" keeps the ring from moving on that line); '
            + 'addMoment ({"when":{"any":[one or more of {"c":"game|music|call|live|recording|timer|dnd|busy|idle"}, {"c":"app|appOpen","app":"obs64"} (an app in front, or open), {"c":"battery","below":10|20|30|50}, {"c":"time","from":"22:00","to":"07:00","days":[0-6]}]},"show":<a face as above>}: a face shown by itself while that is true; moments keep a fixed order, call first); removeMoment (its position, from get_pump_screen); moments (the whole list); '
            + 'alerts ({"notify":true,"call":true,"timer":true,"discord":true,"hot":true,"seconds":4|8|15|30,"hideText":true}: what comes over the face for a moment; hideText keeps what a message says off the pump, which is often on camera); '
            + 'leds ({"follow":"screen|theme|own|lights|off","colors":["#start","#end"],"all":false,"move":"style|<an effect>","speed":50,"reverse":false,"size":null,"glow":null,"palette":null}: the ring of lights around a CORSAIR pump\'s screen, through iCUE on Windows: screen = the colours it shows, a GIF or a song\'s cover too; theme; own = the two colors the user picks, from where the ring starts round to its end, or a palette ready made (palette: '
            + PALETTES + '; null for the two colors); lights = like the other lights; off = dark; all=true (screen or own) gives every other light the ring\'s colour; move = how the ring moves on every line whose own leds is auto: style (the default: as the screen\'s style draws; with xenon sensors and game heat, music aurora, the clock clock; with gauge lit up to the needle, the clock clock; a picture still) or an effect as for leds (a line with no reading keeps level and heat whole); speed = how fast the moving ones go, 1 (slowest) to 100 (fastest), 50 as made (slow, normal, fast still work); reverse=true turns them the other way round; size = how much of the effect, 0..1 (its tail, stars, drops, beam...), null as made; glow = how lit the LEDs the effect leaves dark stay, 0..1, null as made); '
            + 'look ({"rotate":0|90|180|270,"dim":10-100,"night":{"from":"23:00","to":"07:00","dim":30} or null,"fade":true}); name (what the user calls it); '
            + 'style ("xenon" = the faces as they are, the default | "gauge" = Strumento: sensors and game put their first reading on a dial with a needle and the second above it, music the song time, the clock is a dial with hands; picture and widget faces stay as they are; every line keeps its colours and look | "widget:<id>" = a Store widget from get_pump_screen widgets with style:true draws every sensors, game, music and clock line its own way, told which line, and may move the ring when leds.move is "style"; gone or off, Xenon draws the lines) and gauge ({"needle":true,"arc":true}: the needle, and the arc that fills up to it). '
            + 'Only the keys given change. Error "unknown_screen" or "bad_face"/"bad_moment"/"bad_style"/"bad_follow"/"bad_move"/"bad_speed"/"bad_size"/"bad_glow"/"bad_palette" come with "choices"; "bad_led_colors" means colors is not two #rrggbb, "bad_reverse" that reverse is not true or false. Use it for "show the FPS when I play and the cover when music plays", "make the game face red with big numbers", "write my name on the pump", "rotate the pump screen", "make the pump screen look like a car dashboard" (style gauge), "no notifications on the pump", "the pump lights follow the picture", "make the pump lights spin while I play" (the leds of that line), "make the pump lights breathe" (leds move), "a comet round the pump, slowly" (leds move comet, speed 25), "a longer tail" (leds size 0.8), "keep the ring a little lit" (leds glow 0.3), "pump lights in ocean colours" (leds follow own, palette ocean), "pump lights that warm up with the CPU" (leds move heat, cpuTemp first), "the pump colours should follow what it shows" (colors live), "pump lights blue to purple" (leds follow own with colors), "light the pump ring up to the CPU temperature" (leds move level, cpuTemp first), "stop the pump lights moving" (leds move still and the leds of every line auto).',
          params: { patch: 'JSON object with the keys to change', screen: 'Optional: which pump screen' },
        },
      },
    },
    {
      type: 'pumpGet', group: 'xenon', hidden: true, labelKey: 'deck_act_pumpGet', params: [],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpScreen',
        ai: {
          name: 'get_pump_screen',
          description: 'List the pump screens Xenon knows (the LCD on an AIO cooler pump, shown through iCUE, NZXT CAM or as a small monitor) with each one\'s settings (base face, moments in order, alerts, lights, look), what it shows right now and why, its shape and size; widgets lists the installed Store widgets made for a pump that can be its face (id, name, the shapes it was drawn for; style true = it can also be the screen\'s style, "widget:<id>"). here false means its page is not on the pump now (the Xenon Pump widget was taken off in iCUE, or iCUE/CAM is closed): its settings are kept, but it shows nothing of Xenon until the widget is back. An empty list means no pump screen has shown Xenon yet: tell the user to add the Xenon Pump widget in iCUE (Xenon menu, Screens) or to point NZXT CAM\'s web view at http://127.0.0.1:3030/pump-face. Use it before changing a pump, or for "what is on my pump?".',
          params: {},
        },
      },
    },
    // Xenon drawing on a pump screen itself over USB (pump-screen/direct.js): the menu's switch
    // and Bit. A paired phone may, as with the other pump settings.
    {
      type: 'pumpDirect', group: 'xenon', hidden: true, labelKey: 'deck_act_pumpDirect',
      params: [{ name: 'on', kind: 'select', options: ['on', 'off'], optionKeys: { on: 'deck_opt_on', off: 'deck_opt_off' } }],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpDirect',
        ai: {
          name: 'set_pump_direct',
          description: 'Turn on or off Xenon drawing on the pump screen by itself, over USB, with no other program in between (on by default). It works on the pump screens Xenon knows how to speak to (today the CORSAIR iCUE LINK AIO LCD), on Windows and Linux, and only while the program that came with that screen is closed (iCUE on Windows, OpenLinkHub on Linux): Xenon never closes it, the user does. get_pump_screen says what it does now in direct.state: drawing, busy (direct.app is the program holding the screen), none (no such screen plugged in), failed (direct.reason), off. "on" also tries again at once after a failure. Use it for "put Xenon on my pump without iCUE", "stop drawing on the pump", "why is my pump not showing Xenon".',
          params: { on: 'on or off' },
        },
      },
    },
    // Opens iCUE's own import of the Xenon Pump widget on this PC: never a Deck key, and
    // never from a paired phone (paired/remote-actions.js keeps it off FREE).
    {
      type: 'pumpIcue', group: 'xenon', hidden: true, labelKey: 'deck_act_pumpIcue', params: [],
      capability: {
        domain: 'layers', risk: 'safe', requires: 'pumpIcue',
        ai: {
          name: 'add_pump_to_icue',
          description: 'Open CORSAIR iCUE on this PC with the Xenon Pump widget ready to import, so a Corsair pump screen (the round LCD on an iCUE LINK or Elite LCD cooler) can show Xenon. iCUE shows its own import step; then the user picks the widget for the pump screen in iCUE. Answers "no_icue" when iCUE is not installed. Use it for "put Xenon on my Corsair pump", "add the pump widget to iCUE".',
          params: {},
        },
      },
    },
  ];

  return { CAPABILITIES, FACES, SETUPS, STYLES };
});
