// One light in the Dispositivi tab of the lighting hub: a Settings card with what
// the whole device shows (follow Xenon, a colour, an effect, off) and, for
// devices whose layout the server knows, its fans and LEDs to set one by one
// (lighting-map.js). Touching a part of a device that shows one look for all of
// it switches the device to "per part" and keeps every other LED looking the same.
// A board Xenon drives itself shows its outputs as groups of that same map, each
// with its own setup (lighting-setup.js).
(function () {
  'use strict';
  const UI = () => window.LightingUI;

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
      return { style: a.style || 'cycle', color: a.color || '#1ed760', speed: a.speed || 50 };
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
    box.body.appendChild(UI().segmentedRow('lighting_shows', kinds, kind, async (val) => {
      if (val === kind) return;
      if (val === 'color') await setMode({ mode: 'color', color: dev.modeColor || '#1ed760' });
      else if (val === 'effect') await setMode({ mode: 'animation', anim: { ...(dev.modeAnim || {}), style: effectStyle(dev) } });
      else await setMode({ mode: val === 'parts' ? 'custom' : val });
      rerender();
    }, kinds.length));

    if (kind === 'color') {
      box.body.appendChild(UI().colorChoice(dev.modeColor || '#1ed760', (v) => {
        dev.modeColor = v;
        if (hasMap) window.LightingMap.paintColors(box.body, dev, null);
        return setMode({ mode: 'color', color: v });
      }));
    } else if (kind === 'effect') {
      effectControls(rerender, dev, setMode).forEach(n => box.body.appendChild(n));
    }
    if (hasMap) box.body.appendChild(partsSection(rerender, status, dev, setMode, native));
    return box;
  }

  // The effect a device runs, or the one to start from when it runs none.
  function effectStyle(dev) {
    if (dev.mode === 'temperature' || dev.mode === 'album') return dev.mode;
    const s = dev.modeAnim && dev.modeAnim.style;
    return s && s !== 'solid' ? s : 'breathing';
  }

  function effectControls(rerender, dev, setMode) {
    const a = { style: effectStyle(dev), color: '#1ed760', speed: 50, ...(dev.modeAnim || {}) };
    a.style = effectStyle(dev);
    // No 'wave' for a whole device: one device-wide sample would look like the
    // rainbow. A selection of LEDs gets it (lighting-map.js).
    const styles = UI().EFFECTS.filter(([s]) => s !== 'wave');
    const out = [UI().segmented(styles, a.style, async (style) => {
      if (style === 'temperature' || style === 'album') await setMode({ mode: style });
      else await setMode({ mode: 'animation', anim: { ...a, style } });
      rerender();
    }, 3)];
    if (dev.mode === 'animation') {
      UI().effectExtras(a, (patch) => setMode({ mode: 'animation', anim: { ...a, ...patch } }))
        .forEach(n => out.push(n));
    }
    return out;
  }

  function partsSection(rerender, status, dev, setMode, native) {
    const box = UI().el('div', 'lighting-parts');
    box.append(UI().el('span', 'settings-label-line', 'lighting_parts_title', 'Parti e LED'),
      UI().hintP('', native ? 'lighting_native_parts_hint' : 'lighting_parts_hint'));
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
    });
    if (map) box.appendChild(map);
    return box;
  }

  window.LightingDevice = { card, kindOf, wholeDeviceLook };
})();
