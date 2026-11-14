// The panels of the lighting page: the master card, the devices, the effects with their animation
// and palette, and the reactions to events.

(() => {
  'use strict';

  const UI = () => window.LightingUI;

  // Does anything want an iCUE session right now? Mirrors shouldConnect() in
  // server/lighting.js: every effect drives the LEDs on its own, independent of
  // the master toggle, so gating the "not connected" hint on `enabled` alone hid
  // the failure from exactly the users relying on Album → LED or an event flash
  // with the master off. Keep the two lists in step.
  function wantsSession(status) {
    const e = status.effects || {};
    return !!status.enabled || !!e.temperature || !!e.musicAlbum
      || !!(e.timer && e.timer.enabled !== false)
      || !!(e.notification && e.notification.enabled !== false)
      || !!(e.reminder && e.reminder.enabled !== false);
  }

  // Master switch + brightness: they apply to every tab, so they stay on top.
  function masterCard(rerender, status) {
    const card = UI().card();
    card.body.appendChild(UI().toggleRow('lighting_master', status.enabled, async (on) => {
      await UI().post('/api/lighting/effects', { enabled: on });
      rerender();
    }, 'lighting_master_hint'));
    const bright = document.createElement('input');
    bright.type = 'range'; bright.className = 'settings-range'; bright.min = '0'; bright.max = '100';
    bright.value = String(Math.round((status.brightness != null ? status.brightness : 1) * 100));
    bright.addEventListener('change', () => UI().post('/api/lighting/effects', { brightness: Number(bright.value) / 100 }));
    card.body.appendChild(UI().labeledRow('lighting_brightness', bright));
    return card;
  }

  function panel() { return UI().el('div', 'lighting-panel-body'); }

  function devicesPanel(rerender, status, goConnections) {
    const box = panel();
    const perLed = Array.isArray(status.devices) ? status.devices : [];
    perLed.forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, d, d.source === 'native' ? d.maker : 'iCUE')));
    (status.providers || []).forEach((p) => {
      (p.devices || []).filter(d => !(d.needsPairing && !d.paired) && d.optedIn !== false)
        .forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, { ...d, model: d.name || d.host }, p.name)));
    });
    const none = !box.querySelector('.lighting-device');
    const lines = icueProblem(status);
    if (none) lines.unshift(UI().hintP('', 'lighting_devices_empty'));
    if (lines.length) {
      const notice = UI().card();
      notice.body.appendChild(UI().noteRow(lines,
        UI().button(none ? 'settings-btn primary' : 'settings-btn', 'lighting_go_connections', 'Apri Connessioni', goConnections)));
      box.prepend(notice);
    }
    return box;
  }

  // Why Corsair lights are missing, when they are: no SDK component (the ordinary
  // case since iCUE 5.48), or a session that something wants but iCUE refused.
  function icueProblem(status) {
    if (!status.available) {
      return [UI().hintP('Componente iCUE SDK non presente su questo PC. Serve per controllare le luci Corsair: Xenon può scaricarlo da Corsair.', 'lighting_sdk_missing')];
    }
    if (wantsSession(status) && !status.connected) {
      const off = UI().hintP('', 'lighting_icue_off_hint');
      off.classList.add('lighting-warn');
      // The bridge's own reason stays visible: it is what tells a real failure apart.
      return status.reason ? [off, UI().hintP(String(status.reason))] : [off];
    }
    return [];
  }

  const DYNAMIC_ANIM_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];

  function effectsPanel(rerender, status) {
    const box = panel();
    const manual = UI().card('lighting_manual', 'Colore manuale');
    const color = UI().el('div', 'lighting-inline');
    color.append(
      UI().hexColorControl(status.manualColor || '#1ed760', (v) => UI().post('/api/lighting/manual', { color: v })),
      UI().button('settings-btn', 'lighting_manual_clear', 'Reset', () => UI().post('/api/lighting/manual', { clear: true })),
    );
    manual.body.appendChild(UI().noteRow(UI().hintP('', 'lighting_manual_hint'), color));
    box.appendChild(manual);

    const anim = UI().card('lighting_anim', 'Animazione');
    animationSection(rerender, status).forEach(n => anim.body.appendChild(n));
    box.appendChild(anim);
    return box;
  }

  function animationSection(rerender, status) {
    const anim = status.animation || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
    const out = [UI().segmented([
      ['none', 'lighting_anim_none', 'Nessuna'], ['solid', 'lighting_anim_solid', 'Fissa'],
      ['breathing', 'lighting_anim_breathing', 'Respiro'], ['cycle', 'lighting_anim_cycle', 'Arcobaleno'],
      ['wave', 'lighting_anim_wave', 'Onda'], ['aurora', 'lighting_anim_aurora', 'Aurora'],
      ['candle', 'lighting_anim_candle', 'Candela'], ['palette', 'lighting_anim_palette', 'Palette'],
    ], anim.style, async (val) => {
      // The server swaps in the warm candle default colour when appropriate.
      await UI().post('/api/lighting/animation', { style: val });
      rerender();
    }, 4)];
    // "Fissa" reuses the manual colour above; cycle/wave paint the full spectrum;
    // aurora owns its band.
    if (anim.style === 'breathing' || anim.style === 'candle') {
      out.push(UI().labeledRow('lighting_anim_color',
        UI().hexColorControl(anim.color, (v) => UI().post('/api/lighting/animation', { color: v }))));
    }
    if (anim.style === 'palette') out.push(paletteEditor(rerender, anim));
    if (DYNAMIC_ANIM_STYLES.includes(anim.style)) {
      out.push(UI().labeledRow('lighting_anim_speed',
        UI().speedSlider(anim.speed, (v) => UI().post('/api/lighting/animation', { speed: v }))));
    }
    return out;
  }

  // Palette editor: one swatch per colour, ✕ to drop (min 2), "+" to append (max 5).
  function paletteEditor(rerender, anim) {
    const pal = (Array.isArray(anim.palette) && anim.palette.length >= 2) ? anim.palette.slice(0, 5) : ['#1ed760', '#0066ff'];
    // Structural changes re-render; a colour edit only posts — a re-render would
    // steal the focus from the input mid-edit.
    const push = async (next) => { await UI().post('/api/lighting/animation', { palette: next }); rerender(); };
    const row = UI().el('div', 'lighting-palette-row');
    pal.forEach((hex, i) => {
      const cell = UI().el('span', 'lighting-palette-cell');
      cell.appendChild(UI().hexColorControl(hex, (v) => {
        pal[i] = v;
        UI().post('/api/lighting/animation', { palette: pal.slice() });
      }));
      if (pal.length > 2) {
        const rm = UI().button('settings-btn lighting-remove', '', '✕', () => push(pal.filter((_, j) => j !== i)));
        rm.setAttribute('data-i18n-title', 'lighting_palette_remove');
        cell.appendChild(rm);
      }
      row.appendChild(cell);
    });
    if (pal.length < 5) {
      row.appendChild(UI().button('settings-btn', 'lighting_palette_add', 'Aggiungi colore',
        () => push(pal.concat(pal[pal.length - 1]))));
    }
    return UI().labeledRow('lighting_palette_colors', row);
  }

  function reactionsPanel(rerender, status) {
    const box = panel();
    const eff = status.effects || {};
    const auto = UI().card();
    auto.body.append(
      UI().toggleRow('lighting_effect_temperature', eff.temperature !== false,
        (on) => UI().post('/api/lighting/effects', { effects: { temperature: on } }), 'lighting_effect_temperature_hint'),
      UI().toggleRow('lighting_effect_music', eff.musicAlbum !== false,
        (on) => UI().post('/api/lighting/effects', { effects: { musicAlbum: on } }), 'lighting_effect_music_hint'),
      UI().toggleRow('lighting_pause_game', status.pauseDuringGame !== false,
        (on) => UI().post('/api/lighting/effects', { pauseDuringGame: on })),
    );
    box.appendChild(auto);
    const events = UI().card('settings_lighting_events', 'Effetti evento');
    ['timer', 'notification', 'reminder'].forEach(type => events.body.appendChild(eventBlock(rerender, type, eff[type])));
    box.appendChild(events);
    return box;
  }

  // Event flash (timer / notification / reminder): a toggle, and while it is on its
  // colour, style and duration (0.5–10 s) closed under it.
  function eventBlock(rerender, type, ev) {
    const cfg = (ev && typeof ev === 'object') ? ev : { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
    const send = (patch) => UI().post('/api/lighting/effects', { effects: { [type]: patch } });
    const block = UI().el('div', 'lighting-event');
    block.appendChild(UI().toggleRow('settings_lighting_event_' + type, cfg.enabled !== false, async (on) => {
      await send({ enabled: on });
      rerender();
    }));
    if (cfg.enabled === false) return block;

    const opts = UI().el('div', 'settings-grid');
    opts.appendChild(UI().labeledRow('lighting_show_color', UI().hexColorControl(cfg.color || '#ff0000', (v) => send({ color: v }))));
    opts.appendChild(UI().segmentedRow('lighting_event_style', [
      ['blink', 'lighting_style_blink', 'Blink'], ['pulse', 'lighting_style_pulse', 'Pulse'], ['solid', 'lighting_style_solid', 'Solid'],
    ], cfg.style || 'blink', (val) => send({ style: val }), 3));

    const dur = document.createElement('input');
    dur.type = 'range'; dur.className = 'settings-range'; dur.min = '500'; dur.max = '10000'; dur.step = '500';
    dur.value = String(cfg.durationMs || 1800);
    const durRow = UI().labeledRow(null, dur);
    const label = UI().el('span', 'settings-label-line');
    const durVal = UI().el('span', 'settings-value');
    const fmtSecs = (ms) => (ms / 1000).toFixed(1).replace(/\.0$/, '') + ' s';
    durVal.textContent = fmtSecs(Number(dur.value));
    label.append(UI().el('span', '', 'lighting_event_duration', 'Durata'), durVal);
    durRow.prepend(label);
    dur.addEventListener('input', () => { durVal.textContent = fmtSecs(Number(dur.value)); });
    dur.addEventListener('change', () => send({ durationMs: Number(dur.value) }));
    opts.appendChild(durRow);
    const look = UI().el('details', 'settings-expander');
    const name = UI().el('summary');
    name.appendChild(UI().el('span', 'settings-label-line', 'lighting_event_look', 'Colore, stile e durata'));
    look.append(name, opts);
    block.appendChild(look);
    return block;
  }

  window.LightingPagePanels = { UI, masterCard, devicesPanel, effectsPanel, reactionsPanel };
})();
