// What a device's panel shows for each kind of device (lights, heating, blinds, fans, vacuums,
// alarms, valves, mowers, numbers, lists), and the panel of a device with several parts: its
// controls, its readings and its buttons.
'use strict';

window.SmartHomeSheetBodies = (wrapper) => {
  const { callService, iconBtn, pillBtn, actionPills, powerRow, sliderRow, sheetMedia } = wrapper;

  const {
    t, SHEET_DOMAINS, prettify, fmtNum, isOn, splitValue, fmtHvac, domainLabel, stateLabel,
  } = window.SmartHomeStateWords;
  const {
    RUN_DOMAINS, FEAT, has, domainRank, primaryEntity, entityShortName,
  } = window.SmartHomeUnits;
  const { el, ctlGroup, chipGroup, switchRow } = window.SmartHomePieces;

  const LIGHT_SWATCHES = [[255, 147, 41], [255, 190, 140], [255, 244, 229], [212, 229, 255], [130, 175, 255], [255, 84, 84], [97, 222, 140], [181, 120, 255], [255, 110, 196]];
  function sheetLight(e, body) {
    const on = isOn(e);
    body.appendChild(powerRow(e, on));
    const bpct = Number.isFinite(e.brightness) ? Math.round(e.brightness / 255 * 100) : (on ? 100 : 0);
    body.appendChild(sliderRow(t('smarthome_brightness'), bpct, 1, 100, 1, '%', (v) => callService('light', 'turn_on', e.id, { brightness_pct: v })));
    const modes = e.colorModes || [];
    if (modes.includes('color_temp') && Number.isFinite(e.minKelvin) && Number.isFinite(e.maxKelvin) && e.maxKelvin > e.minKelvin) {
      const k = Number.isFinite(e.kelvin) ? e.kelvin : Math.round((e.minKelvin + e.maxKelvin) / 2);
      const row = sliderRow(t('smarthome_white'), k, e.minKelvin, e.maxKelvin, 50, 'K', (v) => callService('light', 'turn_on', e.id, { color_temp_kelvin: v }));
      row.querySelector('.sh-range').classList.add('sh-range--kelvin');
      body.appendChild(row);
    }
    if (modes.some((m) => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(m))) {
      const wrap = el('div', 'sh-swatches');
      LIGHT_SWATCHES.forEach((rgb) => {
        const active = Array.isArray(e.rgb) && e.rgb[0] === rgb[0] && e.rgb[1] === rgb[1] && e.rgb[2] === rgb[2];
        const sw = el('button', 'sh-swatch' + (active ? ' is-active' : '')); sw.type = 'button';
        sw.style.setProperty('--sw', rgb.join(','));
        sw.addEventListener('click', () => callService('light', 'turn_on', e.id, { rgb_color: rgb }));
        wrap.appendChild(sw);
      });
      body.appendChild(ctlGroup(t('smarthome_color'), wrap));
    }
    if (Array.isArray(e.effects) && e.effects.length) body.appendChild(chipGroup(t('smarthome_effect'), e.effects, e.effect, (fx) => callService('light', 'turn_on', e.id, { effect: fx })));
  }

  // A −/big-target/+ temperature stepper, shared by climate and water heater.
  function thermoStepper(target, min, max, step, currentTemp, actionText, onSet) {
    const clamp = (v) => Math.max(min, Math.min(max, Math.round(v * 10) / 10));
    const wrap = el('div', 'sh-thermo');
    const mid = el('div', 'sh-thermo-mid');
    mid.appendChild(el('div', 'sh-thermo-target', fmtNum(target) + '°'));
    if (Number.isFinite(currentTemp)) mid.appendChild(el('div', 'sh-thermo-current', t('smarthome_current') + ' ' + fmtNum(currentTemp) + '°'));
    if (actionText) mid.appendChild(el('div', 'sh-thermo-action', actionText));
    wrap.append(
      iconBtn('sh-step', '<path d="M5 12h14"/>', () => onSet(clamp(target - step)), t('smarthome_volume_down')),
      mid,
      iconBtn('sh-step', '<path d="M12 5v14M5 12h14"/>', () => onSet(clamp(target + step)), t('smarthome_volume_up')),
    );
    return ctlGroup(null, wrap);
  }

  function sheetClimate(e, body) {
    const step = e.step > 0 ? e.step : 0.5;
    const min = Number.isFinite(e.min) ? e.min : 7;
    const max = Number.isFinite(e.max) ? e.max : 35;
    const target = Number.isFinite(e.target) ? e.target : (Number.isFinite(e.current) ? e.current : 20);
    body.appendChild(thermoStepper(target, min, max, step, e.current, e.hvacAction ? prettify(e.hvacAction) : '', (v) => callService('climate', 'set_temperature', e.id, { temperature: v })));
    if (Array.isArray(e.hvacModes) && e.hvacModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.hvacModes, e.state, (m) => callService('climate', 'set_hvac_mode', e.id, { hvac_mode: m }), fmtHvac));
    if (Array.isArray(e.fanModes) && e.fanModes.length) body.appendChild(chipGroup(t('smarthome_fan'), e.fanModes, e.fanMode, (m) => callService('climate', 'set_fan_mode', e.id, { fan_mode: m })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_preset'), e.presetModes, e.presetMode, (m) => callService('climate', 'set_preset_mode', e.id, { preset_mode: m })));
    if (Array.isArray(e.swingModes) && e.swingModes.length) body.appendChild(chipGroup(t('smarthome_swing'), e.swingModes, e.swingMode, (s) => callService('climate', 'set_swing_mode', e.id, { swing_mode: s })));
    if (Number.isFinite(e.currentHumidity)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_humidity') + ' ' + Math.round(e.currentHumidity) + '%'));
  }

  function sheetCover(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.cover.open)) pills.push({ labelText: t('smarthome_open'), svg: '<path d="M12 19V5M6 11l6-6 6 6"/>', onClick: () => callService('cover', 'open_cover', e.id) });
    if (has(f, FEAT.cover.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('cover', 'stop_cover', e.id) });
    if (has(f, FEAT.cover.close)) pills.push({ labelText: t('smarthome_close_cover'), svg: '<path d="M12 5v14M6 13l6 6 6-6"/>', onClick: () => callService('cover', 'close_cover', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.cover.setPos) && Number.isFinite(e.position)) body.appendChild(sliderRow(t('smarthome_position'), e.position, 0, 100, 1, '%', (v) => callService('cover', 'set_cover_position', e.id, { position: v })));
    // Tilt (venetian blinds): open/stop/close tilt + a tilt position slider.
    const tilt = [];
    if (has(f, FEAT.cover.openTilt)) tilt.push(pillBtn(t('smarthome_open'), '<path d="M12 19V5M6 11l6-6 6 6"/>', () => callService('cover', 'open_cover_tilt', e.id)));
    if (has(f, FEAT.cover.stopTilt)) tilt.push(pillBtn(t('smarthome_stop'), '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', () => callService('cover', 'stop_cover_tilt', e.id)));
    if (has(f, FEAT.cover.closeTilt)) tilt.push(pillBtn(t('smarthome_close_cover'), '<path d="M12 5v14M6 13l6 6 6-6"/>', () => callService('cover', 'close_cover_tilt', e.id)));
    if (tilt.length) { const r = el('div', 'sh-abtns'); tilt.forEach((p) => r.appendChild(p)); body.appendChild(ctlGroup(t('smarthome_tilt'), r)); }
    if (has(f, FEAT.cover.setTilt) && Number.isFinite(e.tilt)) body.appendChild(sliderRow(t('smarthome_tilt'), e.tilt, 0, 100, 1, '%', (v) => callService('cover', 'set_cover_tilt_position', e.id, { tilt_position: v })));
  }

  function sheetFan(e, body) {
    const f = e.features || 0;
    body.appendChild(powerRow(e, isOn(e)));
    if (has(f, FEAT.fan.speed)) {
      const pct = Number.isFinite(e.pct) ? e.pct : (isOn(e) ? 100 : 0);
      body.appendChild(sliderRow(t('smarthome_speed'), pct, 0, 100, e.pctStep > 0 ? e.pctStep : 1, '%', (v) => callService('fan', 'set_percentage', e.id, { percentage: v })));
    }
    if (has(f, FEAT.fan.preset) && Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_preset'), e.presetModes, e.presetMode, (m) => callService('fan', 'set_preset_mode', e.id, { preset_mode: m })));
    if (has(f, FEAT.fan.oscillate)) body.appendChild(switchRow(t('smarthome_oscillate'), !!e.oscillating, (v) => callService('fan', 'oscillate', e.id, { oscillating: v })));
    if (has(f, FEAT.fan.direction)) {
      const rev = e.direction === 'reverse';
      const r = el('div', 'sh-abtns');
      const fwd = pillBtn(t('smarthome_forward'), '<path d="M12 19V5M6 11l6-6 6 6"/>', () => callService('fan', 'set_direction', e.id, { direction: 'forward' })); if (!rev) fwd.classList.add('is-active');
      const rv = pillBtn(t('smarthome_reverse'), '<path d="M12 5v14M6 13l6 6 6-6"/>', () => callService('fan', 'set_direction', e.id, { direction: 'reverse' })); if (rev) rv.classList.add('is-active');
      r.append(fwd, rv);
      body.appendChild(ctlGroup(t('smarthome_direction'), r));
    }
  }

  function sheetVacuum(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.vacuum.start)) pills.push({ labelText: t('smarthome_start'), svg: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', onClick: () => callService('vacuum', 'start', e.id) });
    if (has(f, FEAT.vacuum.pause)) pills.push({ labelText: t('smarthome_pause'), svg: '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>', onClick: () => callService('vacuum', 'pause', e.id) });
    if (has(f, FEAT.vacuum.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('vacuum', 'stop', e.id) });
    if (has(f, FEAT.vacuum.return)) pills.push({ labelText: t('smarthome_return'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('vacuum', 'return_to_base', e.id) });
    if (has(f, FEAT.vacuum.cleanSpot)) pills.push({ labelText: t('smarthome_clean_spot'), svg: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>', onClick: () => callService('vacuum', 'clean_spot', e.id) });
    if (has(f, FEAT.vacuum.locate)) pills.push({ labelText: t('smarthome_locate'), svg: '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5" fill="currentColor"/>', onClick: () => callService('vacuum', 'locate', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.vacuum.fanSpeed) && Array.isArray(e.fanSpeeds) && e.fanSpeeds.length) body.appendChild(chipGroup(t('smarthome_speed'), e.fanSpeeds, e.fanSpeed, (s) => callService('vacuum', 'set_fan_speed', e.id, { fan_speed: s })));
    if (Number.isFinite(e.battery)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_battery') + ' ' + Math.round(e.battery) + '%'));
  }

  function sheetHumidifier(e, body) {
    body.appendChild(powerRow(e, isOn(e)));
    if (Number.isFinite(e.target)) body.appendChild(sliderRow(t('smarthome_humidity'), e.target, Number.isFinite(e.min) ? e.min : 0, Number.isFinite(e.max) ? e.max : 100, 1, '%', (v) => callService('humidifier', 'set_humidity', e.id, { humidity: v })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.presetModes, e.presetMode, (m) => callService('humidifier', 'set_mode', e.id, { mode: m })));
  }

  function sheetWaterHeater(e, body) {
    body.appendChild(powerRow(e, isOn(e)));
    const min = Number.isFinite(e.min) ? e.min : 30, max = Number.isFinite(e.max) ? e.max : 80;
    const target = Number.isFinite(e.target) ? e.target : (Number.isFinite(e.current) ? e.current : 50);
    body.appendChild(thermoStepper(target, min, max, 1, e.current, '', (v) => callService('water_heater', 'set_temperature', e.id, { temperature: v })));
    if (Array.isArray(e.presetModes) && e.presetModes.length) body.appendChild(chipGroup(t('smarthome_mode'), e.presetModes, e.presetMode, (m) => callService('water_heater', 'set_operation_mode', e.id, { operation_mode: m })));
  }

  function sheetAlarm(e, body) {
    const f = e.features || 0;
    const st = String(e.state || '');
    const armed = st.indexOf('armed') === 0;
    // Optional code entry (only when the panel requires a code to arm/disarm).
    let codeInput = null;
    if (e.codeArm) {
      const g = el('div', 'sh-ctl');
      g.appendChild(el('div', 'sh-ctl-label', t('smarthome_code')));
      codeInput = el('input', 'sh-chan-input'); codeInput.type = 'password'; codeInput.inputMode = 'numeric'; codeInput.autocomplete = 'off';
      g.appendChild(codeInput); body.appendChild(g);
    }
    const code = () => (codeInput && codeInput.value) ? { code: codeInput.value } : {};
    const arm = [];
    if (has(f, FEAT.alarm.armHome)) arm.push({ labelText: t('smarthome_arm_home'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_home', e.id, code()) });
    if (has(f, FEAT.alarm.armAway)) arm.push({ labelText: t('smarthome_arm_away'), svg: '<path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_away', e.id, code()) });
    if (has(f, FEAT.alarm.armNight)) arm.push({ labelText: t('smarthome_arm_night'), svg: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', onClick: () => callService('alarm_control_panel', 'alarm_arm_night', e.id, code()) });
    if (arm.length) body.appendChild(actionPills(arm));
    const dis = pillBtn(t('smarthome_disarm'), '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>', () => callService('alarm_control_panel', 'alarm_disarm', e.id, code()));
    if (!armed) dis.classList.add('is-active');
    const r = el('div', 'sh-abtns'); r.appendChild(dis);
    body.appendChild(ctlGroup(null, r));
  }

  function sheetValve(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.valve.open)) pills.push({ labelText: t('smarthome_open'), svg: '<path d="M12 19V5M6 11l6-6 6 6"/>', onClick: () => callService('valve', 'open_valve', e.id) });
    if (has(f, FEAT.valve.stop)) pills.push({ labelText: t('smarthome_stop'), svg: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>', onClick: () => callService('valve', 'stop_valve', e.id) });
    if (has(f, FEAT.valve.close)) pills.push({ labelText: t('smarthome_close_cover'), svg: '<path d="M12 5v14M6 13l6 6 6-6"/>', onClick: () => callService('valve', 'close_valve', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (has(f, FEAT.valve.setPos) && Number.isFinite(e.position)) body.appendChild(sliderRow(t('smarthome_position'), e.position, 0, 100, 1, '%', (v) => callService('valve', 'set_valve_position', e.id, { position: v })));
  }

  function sheetLawnMower(e, body) {
    const f = e.features || 0;
    const pills = [];
    if (has(f, FEAT.mower.start)) pills.push({ labelText: t('smarthome_start'), svg: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', onClick: () => callService('lawn_mower', 'start_mowing', e.id) });
    if (has(f, FEAT.mower.pause)) pills.push({ labelText: t('smarthome_pause'), svg: '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>', onClick: () => callService('lawn_mower', 'pause', e.id) });
    if (has(f, FEAT.mower.dock)) pills.push({ labelText: t('smarthome_return'), svg: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>', onClick: () => callService('lawn_mower', 'dock', e.id) });
    if (pills.length) body.appendChild(actionPills(pills));
    if (Number.isFinite(e.battery)) body.appendChild(el('div', 'sh-ctl-note', t('smarthome_battery') + ' ' + Math.round(e.battery) + '%'));
  }

  function sheetNumber(e, body) {
    const min = Number.isFinite(e.min) ? e.min : 0;
    const max = Number.isFinite(e.max) ? e.max : 100;
    const step = e.step > 0 ? e.step : 1;
    const val = Number.isFinite(Number(e.state)) ? Number(e.state) : min;
    body.appendChild(sliderRow(e.name, val, min, max, step, e.unit ? ' ' + e.unit : '', (v) => callService(e.domain, 'set_value', e.id, { value: v })));
  }

  function sheetSelect(e, body) {
    if (Array.isArray(e.options) && e.options.length) body.appendChild(chipGroup(t('smarthome_options'), e.options, e.state, (o) => callService(e.domain, 'select_option', e.id, { option: o })));
    else body.appendChild(el('div', 'sh-ctl-note', prettify(e.state)));
  }

  // fillControls: the domain-specific control block for ONE entity, appended to
  // `body`. Shared by the single-entity sheet and each section of a device panel.
  function fillControls(e, body) {
    switch (e.domain) {
      case 'media_player': sheetMedia(e, body); break;
      case 'light': sheetLight(e, body); break;
      case 'climate': sheetClimate(e, body); break;
      case 'cover': sheetCover(e, body); break;
      case 'fan': sheetFan(e, body); break;
      case 'vacuum': sheetVacuum(e, body); break;
      case 'humidifier': sheetHumidifier(e, body); break;
      case 'water_heater': sheetWaterHeater(e, body); break;
      case 'alarm_control_panel': sheetAlarm(e, body); break;
      case 'valve': sheetValve(e, body); break;
      case 'lawn_mower': sheetLawnMower(e, body); break;
      case 'number': case 'input_number': sheetNumber(e, body); break;
      case 'select': case 'input_select': sheetSelect(e, body); break;
      default: body.appendChild(el('div', 'sh-ctl-note', stateLabel(e)));
    }
  }

  function buildSheetBody(e) {
    const body = el('div', 'sh-sheet-body');
    fillControls(e, body);
    return body;
  }

  // Controls for one MAIN entity inside a device panel — rich sheet controls for
  // capable domains, On/Off for a plain switch/remote, lock/unlock for a lock, else
  // a read-only value line. (Buttons/scenes/scripts are collected into the compact
  // "Actions" group instead, so they don't each become a big section.)
  function deviceEntityControls(e) {
    const c = el('div', 'sh-dev-ctls');
    if (SHEET_DOMAINS.has(e.domain)) fillControls(e, c);
    else if (e.domain === 'remote' || e.domain === 'switch' || e.domain === 'input_boolean' || e.domain === 'siren' || e.domain === 'automation') c.appendChild(powerRow(e, isOn(e)));
    else if (e.domain === 'lock') c.appendChild(actionPills([
      { labelText: t('smarthome_unlocked'), svg: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2.6"/>', onClick: () => callService('lock', 'unlock', e.id) },
      { labelText: t('smarthome_locked'), svg: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', onClick: () => callService('lock', 'lock', e.id) },
    ]));
    else { const p = splitValue(e); c.appendChild(el('div', 'sh-ctl-note', p.num + (p.unit || ''))); }
    return c;
  }

  // A section = a small uppercase label + its controls. Flat (divider between
  // sections, no nested boxes). The label is just the entity TYPE (e.g. "Media
  // player") when the entity is the device itself, or its short name for a distinct
  // part ("Restart") — never the full device name again (it's already the header).
  function deviceSection(e, deviceName) {
    const sec = el('div', 'sh-dev-sec');
    const short = entityShortName(e, deviceName);
    const showName = short && short.toLowerCase() !== String(deviceName || '').toLowerCase();
    sec.appendChild(el('div', 'sh-dev-sec-label', showName ? short + ' · ' + domainLabel(e) : domainLabel(e)));
    sec.appendChild(deviceEntityControls(e));
    return sec;
  }

  // The buttons / scenes / scripts of a device, gathered into ONE compact "Actions"
  // section (small buttons, e.g. Restart / Close apps) rather than a big block each.
  function deviceActions(list, deviceName) {
    const sec = el('div', 'sh-dev-sec');
    sec.appendChild(el('div', 'sh-dev-sec-label', t('smarthome_actions')));
    const row = el('div', 'sh-abtns sh-abtns--wrap');
    list.slice().sort((a, b) => domainRank(a.domain) - domainRank(b.domain)).forEach((e) => {
      const isBtn = e.domain === 'button';
      const b = pillBtn(entityShortName(e, deviceName), isBtn ? '<circle cx="12" cy="12" r="6.5"/>' : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', async () => {
        b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
        if (isBtn) await callService('button', 'press', e.id);
        else await callService(e.domain, 'turn_on', e.id);
      });
      row.appendChild(b);
    });
    sec.appendChild(row);
    return sec;
  }

  // The device panel body. A physical device (a TV) exposes several entities; rather
  // than a confusing section per entity, we present ONE main control block per real
  // control (media/climate/light…), fold the buttons/scenes into a single "Actions"
  // group, and drop a bare `remote` when a media_player already provides power (its
  // only control would just duplicate the media_player's On/Off).
  function buildDeviceBody(entities, deviceName) {
    const body = el('div', 'sh-sheet-body');
    const hasMedia = entities.some((e) => e.domain === 'media_player');
    const actions = [];
    const sections = [];
    entities.forEach((e) => {
      if (e.domain === 'button' || RUN_DOMAINS.has(e.domain)) actions.push(e);
      else if (e.domain === 'remote' && hasMedia) { /* redundant power — skip */ }
      else sections.push(e);
    });
    sections.sort((a, b) => domainRank(a.domain) - domainRank(b.domain));
    sections.forEach((e) => body.appendChild(deviceSection(e, deviceName)));
    if (actions.length) body.appendChild(deviceActions(actions, deviceName));
    if (!body.firstChild) body.appendChild(el('div', 'sh-ctl-note', stateLabel(primaryEntity(entities))));
    return body;
  }

  return { buildSheetBody, buildDeviceBody };
};
