'use strict';
// Pump screens (server/pump-screen/): the LCD on an AIO pump, shown through iCUE's
// widget, NZXT CAM or as a small monitor. The Xenon menu, a Deck key and Bit change
// it through these entries, so the one rule set in js/pump/pump-model.js holds for
// all of them. Same shape as capability-catalog.js, which appends them; the page
// loads this file just before it.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapabilityCatalogPump = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const SCREEN = { name: 'screen', kind: 'text', maxLen: 24, optional: true, labelKey: 'deck_param_pump_screen' };
  const FACES = ['auto', 'next', 'sensors', 'game', 'music', 'clock', 'picture'];
  const SETUPS = ['game', 'music', 'picture', 'clock', 'monitor'];
  const keys = (list, prefix) => Object.fromEntries(list.map((v) => [v, prefix + v]));

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
          description: 'Give the pump\'s screen a ready-made setup in one go, which sets its normal face, its moments and its lights: game (sensor rings; the game face while playing, music while listening), music (a clock; a turning record while music plays), picture (a moving picture; music pulse while listening), clock (a clock with hands) or monitor (four sensor bars). Mounting, name and alerts stay. Use it for "set my pump up for gaming", "make the pump a clock". For anything more precise use set_pump_screen.',
          params: { setup: 'game, music, picture, clock or monitor', screen: 'Optional: which pump screen' },
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
            + 'base (the face shown normally: {"face":"sensors","style":"rings|bars|numbers","readings":[up to 4 of cpuTemp,cpu,gpuTemp,gpu,ram,vram,power,fps,cpuClock,gpuClock]} | {"face":"game","readings":[...],"track":true} | {"face":"music","style":"cover|vinyl|pulse"} | {"face":"clock","style":"digital|analog","seconds":false,"date":true,"weather":true} | {"face":"picture","items":["art:aurora|art:ember|art:tide|art:orbit" or "/uploads/<file>" from the user\'s uploads; for a file of theirs not uploaded yet call choose_pump_picture],"every":5|10|30|60|300,"fit":"cover|contain"} | {"face":"widget","id":"<an id from get_pump_screen widgets>"}: a Store widget made for a pump, which runs with the permissions the user gave it). '
            + 'Any face, in base or a moment, also takes its own look: "colors" (xenon, theme, picture = the colours of the cover or picture on show, fire, ice, violet, mono, or a colour like "#ff0044"), "bg" (black, glow, art:aurora|art:ember|art:tide|art:orbit, or "/uploads/<file>": behind sensors, game and clock), "size" (normal|big: the numbers), "units" (auto|c|f: its temperatures), "warn" (false: warm readings keep their colour), "text" (words of the user on it, up to 24 characters), "leds" (auto|still|breathe|spin|beat: how the ring of lights around the pump moves while this line shows, in its colours; spin = a light running round; beat = with the sound, Windows; auto = as the leds of the screen say); a widget face takes colors, size, units and leds and uses the first three if made to. Another face on the same line keeps its look; "xenon", "black", "normal", "auto", true and "" put a field back (leds "still" keeps the ring from moving on that line); '
            + 'addMoment ({"when":{"any":[one or more of {"c":"game|music|call|live|recording|timer|dnd|busy|idle"}, {"c":"app|appOpen","app":"obs64"} (an app in front, or open), {"c":"battery","below":10|20|30|50}, {"c":"time","from":"22:00","to":"07:00","days":[0-6]}]},"show":<a face as above>}: a face shown by itself while that is true; moments keep a fixed order, call first); removeMoment (its position, from get_pump_screen); moments (the whole list); '
            + 'alerts ({"notify":true,"call":true,"timer":true,"discord":true,"hot":true,"seconds":4|8|15|30,"hideText":true}: what comes over the face for a moment; hideText keeps what a message says off the pump, which is often on camera); '
            + 'leds ({"follow":"screen|theme|lights|off","all":false,"pulse":false}: the ring of lights around a CORSAIR pump\'s screen, through iCUE on Windows: screen = the colours it shows, a GIF or a song\'s cover too; theme; lights = like the other lights; off = dark; all=true gives every other light the screen\'s colour; pulse=true makes the ring breathe with the sound the PC plays, Windows); '
            + 'look ({"rotate":0|90|180|270,"dim":10-100,"night":{"from":"23:00","to":"07:00","dim":30} or null,"fade":true}); name (what the user calls it). '
            + 'Only the keys given change. Error "unknown_screen" or "bad_face"/"bad_moment" come with "choices". Use it for "show the FPS when I play and the cover when music plays", "make the game face red with big numbers", "write my name on the pump", "rotate the pump screen", "no notifications on the pump", "the pump lights follow the picture", "make the pump lights spin while I play", "stop the pump lights moving".',
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
          description: 'List the pump screens Xenon knows (the LCD on an AIO cooler pump, shown through iCUE, NZXT CAM or as a small monitor) with each one\'s settings (base face, moments in order, alerts, lights, look), what it shows right now and why, its shape and size; widgets lists the installed Store widgets made for a pump that can be its face (id, name, the shapes it was drawn for). here false means its page is not on the pump now (the Xenon Pump widget was taken off in iCUE, or iCUE/CAM is closed): its settings are kept, but it shows nothing of Xenon until the widget is back. An empty list means no pump screen has shown Xenon yet: tell the user to add the Xenon Pump widget in iCUE (Xenon menu, Screens) or to point NZXT CAM\'s web view at http://127.0.0.1:3030/pump-face. Use it before changing a pump, or for "what is on my pump?".',
          params: {},
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

  return { CAPABILITIES, FACES, SETUPS };
});
