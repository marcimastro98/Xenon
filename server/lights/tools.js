// What the assistant does when asked about the lights of the PC: a colour, the effects, the
// animation, and the lights on or off.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const lighting = require('../lighting.js');
const { LIGHTING_ANIM_STYLES } = require('./settings-normalize.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'set_lights': async ({ fnArgs }) => {
      let fnResult;
      const ok = lighting.setManualColor(fnArgs.color);
      fnResult = ok ? { ok: true, color: String(fnArgs.color || '') }
                    : { error: 'unknown_colour', hint: 'use a colour name or #RRGGBB' };
      return fnResult;
  },

  'clear_lights': async () => {
      let fnResult;
      lighting.clearManual();
      fnResult = { ok: true };
      return fnResult;
  },

  'set_effect': async ({ fnArgs }, { _persistLighting }) => {
      let fnResult;
      const eff = String(fnArgs.effect || '');
      let ok = false;
      if (eff === 'volume') {
        // The volume-flash effect was removed — be honest instead of confirming a no-op.
        fnResult = { error: 'effect_removed', hint: 'the volume flash effect no longer exists; available: temperature, musicAlbum, timer, notification, reminder' };
      } else {
        if (['temperature', 'musicAlbum'].includes(eff)) {
          lighting.applyConfig({ effects: { [eff]: !!fnArgs.enabled } }); ok = true;
        } else if (['timer', 'notification', 'reminder'].includes(eff)) {
          lighting.applyConfig({ effects: { [eff]: { enabled: !!fnArgs.enabled } } }); ok = true;
        }
        if (ok) await _persistLighting();
        fnResult = ok ? { ok: true, effect: eff, enabled: !!fnArgs.enabled }
                      : { error: 'unknown_effect', hint: 'one of: temperature, musicAlbum, timer, notification, reminder' };
      }
      return fnResult;
  },

  'set_event_effect': async ({ fnArgs }, { _persistLighting }) => {
      let fnResult;
      const eff = String(fnArgs.effect || '');
      if (!['timer', 'notification', 'reminder'].includes(eff)) {
        fnResult = { error: 'unknown_effect', hint: 'one of: timer, notification, reminder' };
      } else {
        const patch = {};
        if (fnArgs.color != null) {
          const c = lighting._fx.parseColorName(fnArgs.color);
          if (c) patch.color = lighting._fx.rgbToHex(c);
        }
        if (['blink', 'pulse', 'solid'].includes(fnArgs.style)) patch.style = fnArgs.style;
        if (typeof fnArgs.enabled === 'boolean') patch.enabled = fnArgs.enabled;
        lighting.applyConfig({ effects: { [eff]: patch } });
        await _persistLighting();
        fnResult = { ok: true, effect: eff, config: lighting.getConfig().effects[eff] };
      }
      return fnResult;
  },

  'set_animation': async ({ fnArgs }, { _persistLighting }) => {
      let fnResult;
      const patch = {};
      if (typeof fnArgs.style === 'string') patch.style = fnArgs.style.trim();
      if (fnArgs.color != null) {
        const c = lighting._fx.parseColorName(fnArgs.color);
        if (c) patch.color = lighting._fx.rgbToHex(c);
      }
      if (fnArgs.speed != null) patch.speed = Number(fnArgs.speed);
      if (typeof fnArgs.palette === 'string' && fnArgs.palette.trim()) {
        patch.palette = fnArgs.palette.split(',').map(s => s.trim()).filter(Boolean);
      }
      // setAnimation silently ignores unknown styles — validate here so the AI
      // hears "invalid" instead of confirming a change that didn't happen.
      if (patch.style && !LIGHTING_ANIM_STYLES.includes(patch.style)) {
        fnResult = { error: 'invalid_animation', hint: 'style must be one of: ' + LIGHTING_ANIM_STYLES.join(', ') };
      } else {
        lighting.setAnimation(patch);
        await _persistLighting();
        fnResult = { ok: true, animation: lighting.getConfig().animation, hint: lighting.getConfig().enabled ? undefined : 'lighting master is OFF: call set_lighting_bridge to make the animation visible' };
      }
      return fnResult;
  },

  'set_lighting_bridge': async ({ fnArgs }, { _persistLighting }) => {
      let fnResult;
      lighting.setLightsOut(!fnArgs.enabled && fnArgs.dark === true);
      lighting.setEnabled(!!fnArgs.enabled);
      if (fnArgs.enabled || fnArgs.dark === true) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      fnResult = { ok: true, enabled: !!fnArgs.enabled, status: lighting.getStatus() };
      return fnResult;
  },
};

module.exports = { branches };
