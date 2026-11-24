// One light in the Dispositivi tab of the lighting hub: a Settings card with what
// the whole device shows (follow Xenon, a colour, an effect, off) and, for
// devices whose layout the server knows, its fans and LEDs to set one by one
// (lighting-map.js). Touching a part of a device that shows one look for all of
// it switches the device to "per part" and keeps every other LED looking the same.
// A board Xenon drives itself shows its outputs as groups of that same map, each
// with its own setup (lighting-setup.js). While a pump screen holds its ring of lights, the
// card and the ring's part on the map say so, with the way to the pump's Lights tab.
(function () {
  'use strict';
  const UI = () => window.LightingUI;

  // Open or closed per device: a redraw after a paint must not shut it under the finger.
  const partsOpen = new Map();

  // The pump's ring is the pump screen's while it shows a look of its own (status.pumpRing:
  // server/lights/pump-ring.js state, and the devices that carry the ring): what is set here
  // does not reach it.
  const holdsPump = (status, dev) => status.pumpRing?.owns === true
    && Array.isArray(status.pumpRing.devices) && status.pumpRing.devices.includes(dev.id);

  // The pump card in the Xenon menu, on its Lights tab (js/menu/xenon-menu-screens.js want).
  function openPumpLights() {
    if (window.XenonMenuScreens && typeof window.XenonMenuScreens.want === 'function') window.XenonMenuScreens.want('leds');
    window.XenonMenuPanel.open('screens');
  }

  // A line saying the pump screen decides, and the button to its Lights tab where the menu is here.
  function pumpNote(textKey, fallback, buttonKey, buttonFallback) {
    const opens = !!(window.XenonMenuPanel && typeof window.XenonMenuPanel.open === 'function');
    return UI().noteRow(UI().hintP(fallback, textKey), opens ? UI().button('settings-btn', buttonKey, buttonFallback, openPumpLights) : null);
  }

  // The server modes, folded into the four choices a person makes.
  function kindOf(dev) {
    const mode = dev.mode || 'follow';
    if (mode === 'custom') return 'parts';
    if (mode === 'animation' || mode === 'temperature' || mode === 'album') return 'effect';
    return mode === 'color' || mode === 'off' ? mode : 'follow';
  }

  // The look every LED of a single-look device has now, as a LED value: what the
  // other LEDs keep when one part gets its own. null = follows Xenon.
  function wholeDeviceLook(dev) {
    const mode = dev.mode || 'follow';
    const a = dev.modeAnim || {};
    if (mode === 'color') return dev.modeColor || null;
    if (mode === 'off') return '#000000';
    if (mode === 'temperature' || mode === 'album') return { style: mode };
    if (mode === 'animation') {
      if (a.style === 'solid') return a.color || null;
      // A LED keeps one colour: the old 'palette' is the effect it became.
      return { style: a.style === 'palette' ? 'turn' : a.style || 'shift', color: a.color || '#1ed760', speed: a.speed || 50 };
    }
    return null;
  }

  function card(rerender, status, dev, brand) {
    const box = UI().card('', dev.model || dev.id, UI().el('span', 'lighting-device-brand', '', brand));
    box.classList.add('lighting-device');
    const setMode = (patch) => UI().post('/api/lighting/device-mode', { id: dev.id, ...patch });
    const native = dev.source === 'native' && !!window.LightingSetup;
    const hasMap = native || (Array.isArray(dev.segments) && dev.segments.some(s => s.ledIds && s.ledIds.length));
    const kind = kindOf(dev);

    const kinds = [
      ['follow', 'lighting_show_follow', 'Segue Xenon'], ['color', 'lighting_show_color', 'Colore'],
      ['effect', 'lighting_show_effect', 'Effetto'], ['off', 'lighting_show_off', 'Spento'],
    ];
    // "Per part" is a state the map puts the device in, shown so the choice above
    // never looks blank; picking one of the four gives the device one look again.
    if (kind === 'parts') kinds.push(['parts', 'lighting_show_parts', 'Per parte']);
    if (holdsPump(status, dev)) {
      box.body.appendChild(pumpNote('lighting_pump_holds', 'L’anello della pompa lo decide lo schermo della pompa', 'lighting_pump_open', 'Apri le luci della pompa'));
    }
    box.body.appendChild(UI().segmentedRow('lighting_shows', kinds, kind, async (val) => {
      if (val === kind) return;
      if (val === 'color') await setMode({ mode: 'color', color: dev.modeColor || '#1ed760' });
      else if (val === 'effect') await setMode({ mode: 'animation', anim: { ...(dev.modeAnim || {}), style: effectStyle(dev) } });
      else await setMode({ mode: val === 'parts' ? 'custom' : val });
      rerender();
    }, kinds.length));

    if (kind === 'color') {
      box.body.appendChild(UI().labeledRow('lighting_show_color', UI().colorChoice(dev.modeColor || '#1ed760', (v) => {
        dev.modeColor = v;
        if (hasMap) window.LightingMap.paintColors(box.body, dev, null);
        return setMode({ mode: 'color', color: v });
      })));
    } else if (kind === 'effect') {
      box.body.appendChild(effectControls(rerender, status, dev, setMode));
    }
    if (hasMap) box.body.appendChild(partsSection(rerender, status, dev, setMode, native));
    return box;
  }

  // The effect a device runs, or the one to start from when it runs none.
  function effectStyle(dev) {
    if (dev.mode === 'temperature' || dev.mode === 'album') return dev.mode;
    const s = dev.modeAnim && dev.modeAnim.style;
    return s || 'breathe';
  }

  // The effect cards (lighting-page/effect-cards.js), the CPU temperature and the album first.
  function effectControls(rerender, status, dev, setMode) {
    const a = { color: '#1ed760', speed: 50, ...(dev.modeAnim || {}), style: effectStyle(dev) };
    const lead = (style) => UI().EFFECT_LEADS.some(([s]) => s === style);
    return UI().effectCards({
      look: a, cannot: status.cannot, lead: UI().EFFECT_LEADS,
      onPick: async (style) => {
        await setMode(lead(style) ? { mode: style } : { mode: 'animation', anim: { ...a, style } });
        rerender();
      },
      onChange: async (patch, redraw) => {
        await setMode({ mode: 'animation', anim: { ...a, ...patch } });
        if (redraw) rerender();
      },
    });
  }

  function partsSection(rerender, status, dev, setMode, native) {
    const box = UI().el('details', 'settings-expander');
    // A board is set up here and a per-part device lives here: those start open.
    box.open = partsOpen.has(dev.id) ? partsOpen.get(dev.id) : native || dev.mode === 'custom';
    box.addEventListener('toggle', () => partsOpen.set(dev.id, box.open));
    const name = UI().el('summary');
    name.appendChild(UI().el('span', 'settings-label-line', 'lighting_parts_title', 'Parti e LED'));
    const body = UI().el('div', 'lighting-parts');
    body.appendChild(UI().hintP('', native ? 'lighting_native_parts_hint' : 'lighting_parts_hint'));
    const allIds = (dev.segments || []).flatMap(s => s.ledIds || []);
    const fx = status.effects || {};
    const map = window.LightingMap.build(dev, {
      onPaint: async (patch) => {
        const wasCustom = dev.mode === 'custom';
        let leds = patch;
        if (!wasCustom) {
          const keep = wholeDeviceLook(dev);
          leds = {};
          allIds.forEach((id) => { leds[id] = keep; });
          Object.assign(leds, patch);
        }
        // Local state first, so the map redraws before the server answers.
        const next = { ...(wasCustom ? dev.modeLeds : {}) };
        Object.entries(leds).forEach(([k, v]) => { if (v === null) delete next[k]; else next[k] = v; });
        // Every LED back to Xenon: the server puts the device on "follows Xenon".
        const emptied = !Object.keys(next).length;
        dev.mode = emptied ? 'follow' : 'custom';
        dev.modeLeds = next;
        await setMode({ mode: 'custom', leds });
        // A painted LED has to be visible: the map is useless with Xenon's
        // lighting switched off, so the first paint switches it on.
        if (!status.enabled) await UI().post('/api/lighting/effects', { enabled: true });
        if (!wasCustom || !status.enabled || emptied) rerender();
      },
      // Album and temperature colours keep changing, so "follow" is drawn neutral then.
      liveColor: fx.musicAlbum || fx.temperature ? null : (status.manualColor || 'var(--accent)'),
      groups: native ? window.LightingSetup.groups(dev, status, rerender) : null,
      held: holdsPump(status, dev) ? ['pump'] : [],
      cannot: status.cannot,
    });
    if (map) body.appendChild(map);
    box.append(name, body);
    return box;
  }

  window.LightingDevice = { card, kindOf, wholeDeviceLook, pumpNote };
})();
