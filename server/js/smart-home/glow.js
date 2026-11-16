// How a Smart Home card is coloured: a lit light glows in its own colour, scaled by its brightness,
// and a reading is tinted by what it measures.
'use strict';

(() => {
  // The signature detail: an ON light emits its OWN colour. If Home Assistant
  // reports the bulb's rgb, the card glows in that hue; otherwise a warm bulb
  // amber. Switches/plugs glow in the dashboard accent. Brightness scales the
  // intensity, so a dimmed lamp glows softly and a bright one blooms.
  function glowRgb(e) {
    if (e.domain === 'light' && Array.isArray(e.rgb) && e.rgb.length === 3) return e.rgb.join(', ');
    if (e.domain === 'light') return '255, 197, 122';
    return 'var(--accent-rgb)';
  }

  function glowAlpha(e) {
    if (e.domain === 'light' && Number.isFinite(e.brightness)) return (0.14 + (e.brightness / 255) * 0.24).toFixed(3);
    return '0.2';
  }

  // Instrument colour-coding for value tiles — by what the sensor measures.
  const TINT = {
    temperature: '250, 150, 90', humidity: '90, 170, 250', power: '250, 200, 90', energy: '250, 200, 90',
    battery: '74, 222, 128', pm25: '74, 222, 128', aqi: '74, 222, 128', illuminance: '250, 210, 120',
    pressure: '160, 150, 240', carbon_dioxide: '120, 200, 160', voc: '120, 200, 160',
  };

  function tintRgb(e) { return TINT[e.deviceClass] || (e.domain === 'climate' ? '250, 150, 90' : 'var(--accent-rgb)'); }

  window.SmartHomeGlow = { glowRgb, glowAlpha, tintRgb };
})();
