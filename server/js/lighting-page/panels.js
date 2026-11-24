// The panels of the lighting page: the master card, the devices, the effects with their animation
// and palette, and the reactions to events.

(() => {
  'use strict';

  const UI = () => window.LightingUI;

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

  // While the pump screen leads every light ("same colours across the PC", in the pump's Lights
  // tab), the lights that follow Xenon show it instead of what this tab sets (an event flash still
  // comes first, lights/paint.js): said on top, with the way to change it there.
  function pumpLeads(box, status, key, fallback) {
    if (!(status.pumpRing && status.pumpRing.all === true) || !window.LightingDevice) return;
    const card = UI().card();
    card.body.appendChild(window.LightingDevice.pumpNote(key, fallback, 'lighting_pump_change', 'Cambia'));
    box.appendChild(card);
  }

  // Who drives each light now (lights/drivers.js), on top of Devices: a light nobody drives says
  // why and offers the one thing to do, so a flash that reaches only some lights is never a mystery.
  const WHO = {
    xenon: ['lighting_who_xenon', 'Xenon'], network: ['lighting_who_network', 'Xenon, in rete'],
    pump: ['lighting_who_pump', 'Lo schermo della pompa'], nobody: ['lighting_who_nobody', 'Nessuno'],
    error: ['lighting_who_error', 'Non risponde'],
  };
  const isOff = (row) => row.who === 'nobody' || row.who === 'error';

  function whoText(row) {
    if (row.who === 'other') return String(row.through || '');   // a program that paints the board (lights/drivers.js)
    if (row.who === 'via') return UI().tr('lighting_who_via', 'Xenon, tramite {name}').replace('{name}', String(row.through || ''));
    const [key, fallback] = WHO[row.who] || WHO.nobody;
    return UI().tr(key, fallback);
  }

  function fixButton(rerender, row, goConnections) {
    if (row.fix === 'board') {
      return UI().button('settings-btn primary', 'lighting_board_take', 'Comandale con Xenon', async () => {
        await UI().post('/api/lighting/native', { enabled: true });
        rerender();
      });
    }
    return row.fix === 'connections' ? UI().button('settings-btn', 'lighting_go_connections', 'Apri Connessioni', goConnections) : null;
  }

  function whoRow(rerender, row, goConnections) {
    const name = UI().el('span', 'lighting-who-name', row.nameKey || '', row.nameKey ? '' : String(row.name || ''));
    const brand = row.count > 1 ? UI().tr('lighting_who_count', '{n} dispositivi').replace('{n}', String(row.count)) : row.brand;
    const label = UI().el('span', 'settings-label-line');
    label.append(name);
    if (brand) label.append(UI().el('span', 'lighting-device-brand', '', String(brand)));
    const head = UI().el('div', 'settings-row lighting-row lighting-who');
    head.append(label, UI().el('span', 'lighting-who-state' + (isOff(row) ? ' is-off' : ''), '', whoText(row)));
    if (!isOff(row) && row.who !== 'other') return [head];
    const why = [];
    if (row.reasonKey) why.push(UI().hintP('', row.reasonKey));
    if (row.reason) why.push(UI().hintP(String(row.reason)));
    return [head, UI().noteRow(why, fixButton(rerender, row, goConnections))];
  }

  // Lights Xenon drives that still follow it and had a look in iCUE (lights/icue-import.js): one
  // tap brings that look over, for whoever leaves iCUE closed.
  function icueImportRow(rerender, lights) {
    const names = lights.map((l) => String(l.name || l.id)).join(', ');
    const hint = UI().hintP(UI().tr('lighting_icue_import_hint', '{names}: puoi riprendere l\'effetto e il colore che avevi in iCUE.').replace('{names}', names));
    return UI().noteRow([hint], UI().button('settings-btn', 'lighting_icue_import', 'Importa da iCUE', async () => {
      await UI().post('/api/lighting/icue-import', {});
      rerender();
    }));
  }

  function whoCard(rerender, rows, goConnections, imports) {
    const card = UI().card('lighting_who_title', 'Chi comanda le luci');
    for (const row of rows) card.body.append(...whoRow(rerender, row, goConnections));
    if (imports.length) card.body.appendChild(icueImportRow(rerender, imports));
    card.body.appendChild(UI().noteRow([], UI().button('settings-btn', 'lighting_who_add', 'Aggiungi altre luci', goConnections)));
    return card;
  }

  function devicesPanel(rerender, status, goConnections) {
    const box = panel();
    const perLed = Array.isArray(status.devices) ? status.devices : [];
    perLed.forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, d, d.source === 'native' ? d.maker : 'iCUE')));
    (status.providers || []).forEach((p) => {
      (p.devices || []).filter(d => !(d.needsPairing && !d.paired) && d.optedIn !== false)
        .forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, { ...d, model: d.name || d.host }, p.name)));
    });
    const rows = Array.isArray(status.drivers) ? status.drivers : [];
    const imports = Array.isArray(status.icueImport) ? status.icueImport : [];
    if (rows.length) box.prepend(whoCard(rerender, rows, goConnections, imports));
    else if (!box.querySelector('.lighting-device')) box.prepend(emptyCard(goConnections));
    return box;
  }

  function emptyCard(goConnections) {
    const notice = UI().card();
    notice.body.appendChild(UI().noteRow([UI().hintP('', 'lighting_devices_empty')],
      UI().button('settings-btn primary', 'lighting_go_connections', 'Apri Connessioni', goConnections)));
    return notice;
  }

  function effectsPanel(rerender, status) {
    const box = panel();
    pumpLeads(box, status, 'lighting_pump_all', 'Ora le luci che seguono Xenon prendono i colori dello schermo della pompa');
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

  // The effect for every light that follows Xenon, as cards (lighting-page/effect-cards.js). A
  // colour typed in a swatch only posts: a redraw would take the focus from it mid-edit.
  function animationSection(rerender, status) {
    const look = status.animation || { style: 'none' };
    return [UI().effectCards({
      look, cannot: status.cannot, chain: true, lead: [['none', 'lighting_anim_none', 'Nessuna']],
      onPick: async (style) => { await UI().post('/api/lighting/animation', { style }); rerender(); },
      onChange: async (patch, redraw) => { await UI().post('/api/lighting/animation', patch); if (redraw) rerender(); },
    })];
  }

  function reactionsPanel(rerender, status) {
    const box = panel();
    pumpLeads(box, status, 'lighting_pump_all_reactions', 'Ora le luci che seguono Xenon prendono i colori dello schermo della pompa, al posto di copertina e temperatura. Gli avvisi lampeggiano lo stesso.');
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
