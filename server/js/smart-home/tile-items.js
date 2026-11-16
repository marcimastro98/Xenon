// The cards of the Smart Home tile: a guided empty card, a switch, a run button, a device that
// opens its panel, a media player, a reading tinted by what it measures, a device with several
// parts; a lit light glows in its own colour.
'use strict';

window.SmartHomeTileItems = (wrapper) => {
  const { SVG, ICONS, iconFor, callService, openSheet, openDevice } = wrapper;

  const {
    t, SHEET_DOMAINS, isOn, splitValue, friendlyState, stateLabel, controlSummary, deviceReadings,
    deviceSummary,
  } = window.SmartHomeStateWords;
  const { TOGGLE_DOMAINS, RUN_DOMAINS, primaryEntity } = window.SmartHomeUnits;
  const { el } = window.SmartHomePieces;
  const { glowRgb, glowAlpha, tintRgb } = window.SmartHomeGlow;

  function applyGlow(node, e) {
    node.style.setProperty('--sh-glow', glowRgb(e));
    node.style.setProperty('--sh-glow-a', glowAlpha(e));
  }

  function openSmartHomeSettings() {
    openSettingsCategory('smarthome');
  }

  // A guided empty state (not configured / offline / nothing picked).
  function emptyCard(msgKey) {
    const card = el('div', 'sh-empty');
    const ico = el('div', 'sh-empty-ico'); ico.innerHTML = ICONS.home;   // static, trusted SVG
    card.append(ico, el('div', 'sh-empty-msg', t(msgKey, '')));
    const btn = el('button', 'sh-empty-btn', t('smarthome_open_settings', 'Open Settings'));
    btn.type = 'button';
    btn.addEventListener('click', openSmartHomeSettings);
    card.appendChild(btn);
    return card;
  }

  // A single toggle row (light/switch/…): icon + name, tap toggles it. Optimistic
  // flip for instant feedback; the SSE push reconciles the real state right after.
  // On sheet-capable devices (light, fan) the switch still toggles, but tapping the
  // rest of the card opens the full control panel instead of a blunt on/off.
  function toggleItem(e) {
    const hasSheet = SHEET_DOMAINS.has(e.domain);
    const on = isOn(e);
    const b = el('button', 'sh-item sh-item--toggle' + (on ? ' is-on' : '') + (hasSheet ? ' has-sheet' : ''));
    b.type = 'button';
    if (on) applyGlow(b, e);                            // lit card emits the bulb's colour
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.append(el('span', 'sh-item-name', e.name), el('span', 'sh-item-sub', stateLabel(e)));
    const sw = el('span', 'sh-switch');
    b.append(ico, body, sw);
    const doToggle = () => {
      const nowOn = !b.classList.contains('is-on');
      b.classList.toggle('is-on', nowOn);              // optimistic
      if (nowOn) applyGlow(b, e); else { b.style.removeProperty('--sh-glow'); b.style.removeProperty('--sh-glow-a'); }
      callService('homeassistant', 'toggle', e.id);
    };
    sw.addEventListener('click', (ev) => { ev.stopPropagation(); doToggle(); });
    b.addEventListener('click', () => { if (hasSheet) openSheet(e.id); else doToggle(); });
    return b;
  }

  // A run button (scene / script / button): tap activates it, with a confirm flash.
  function runItem(e) {
    const b = el('button', 'sh-item sh-item--run');
    b.type = 'button';
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.appendChild(el('span', 'sh-item-name', e.name));
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG(e.domain === 'button' ? '<circle cx="12" cy="12" r="6.5"/>' : '<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body, go);
    b.addEventListener('click', async () => {
      b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
      if (e.domain === 'button') await callService('button', 'press', e.id);
      else await callService(e.domain, 'turn_on', e.id);
    });
    return b;
  }

  // A control card (climate/cover/vacuum/number/select): a glanceable summary of the
  // device's current state + a chevron; tapping it opens the full control panel.
  function controlItem(e) {
    const b = el('button', 'sh-item sh-item--control' + (isOn(e) ? ' is-on' : ''));
    b.type = 'button';
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    body.append(el('span', 'sh-item-name', e.name), el('span', 'sh-item-sub', controlSummary(e)));
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG('<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body, go);
    b.addEventListener('click', () => openSheet(e.id));
    return b;
  }

  // A media player card: an album-art chip (gradient placeholder — the real cover
  // is auth-gated behind HA) + what's playing + a play/pause. Tapping the art/body
  // opens the full remote (power, volume, sources…); play/pause stays inline.
  function mediaItem(e) {
    const playing = e.state === 'playing';
    const row = el('div', 'sh-item sh-item--media' + (playing ? ' is-playing' : ''));
    const open = el('button', 'sh-media-open'); open.type = 'button';
    const art = el('span', 'sh-media-art'); art.innerHTML = iconFor(e);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    const title = e.title || e.name;
    const sub = e.title ? (e.artist || e.name)
      : (playing ? e.name : (e.state && !['off', 'unavailable', 'unknown', 'idle', ''].includes(e.state) ? friendlyState(e) : t('smarthome_off', 'Off')));
    body.append(el('span', 'sh-item-name', title), el('span', 'sh-item-sub', sub));
    open.append(art, body);
    open.addEventListener('click', () => openSheet(e.id));
    const play = el('button', 'sh-mini-btn');
    play.type = 'button';
    play.innerHTML = playing
      ? SVG('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>')
      : SVG('<path d="M8 5v14l11-7z"/>');
    play.addEventListener('click', (ev) => { ev.stopPropagation(); callService('media_player', 'media_play_pause', e.id); });
    row.append(open, play);
    return row;
  }

  // A read-only value tile (sensor / climate / binary_sensor / …): an instrument
  // reading — big tabular number + small unit, tinted by what it measures.
  function valueItem(e) {
    const card = el('div', 'sh-item sh-item--value');
    card.style.setProperty('--sh-tint', tintRgb(e));
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(e);   // static, trusted SVG
    card.appendChild(ico);
    const body = el('div', 'sh-item-body');
    const val = el('span', 'sh-item-val');
    const parts = splitValue(e);
    val.appendChild(document.createTextNode(parts.num));
    if (parts.unit) val.appendChild(el('span', 'sh-item-unit', parts.unit));
    body.append(val, el('span', 'sh-item-name', e.name));
    card.appendChild(body);
    return card;
  }

  function buildItem(e) {
    if (e.domain === 'media_player') return mediaItem(e);
    if (RUN_DOMAINS.has(e.domain)) return runItem(e);
    if (TOGGLE_DOMAINS.has(e.domain)) return toggleItem(e);
    if (SHEET_DOMAINS.has(e.domain)) return controlItem(e);
    return valueItem(e);
  }

  // A merged DEVICE card: several HA entities of one physical device (a TV = a
  // media_player + remote + buttons) collapse into a single card that opens a
  // unified control panel — so the TV appears once, not four times.
  function deviceCard(unit) {
    const pe = primaryEntity(unit.entities);
    const anyOn = unit.entities.some((x) => isOn(x));
    // A device made of sensors shows its readings instead of an entity count,
    // on a card two columns wide so they read in full.
    const readings = SHEET_DOMAINS.has(pe.domain) || TOGGLE_DOMAINS.has(pe.domain) ? [] : deviceReadings(unit.entities);
    const b = el('button', 'sh-item sh-item--control sh-item--device' + (readings.length ? ' sh-item--readings' : '') + (anyOn ? ' is-on' : ''));
    b.type = 'button';
    if (anyOn && pe.domain === 'light') applyGlow(b, pe);
    const ico = el('span', 'sh-item-ico'); ico.innerHTML = iconFor(pe);   // static, trusted SVG
    const body = el('div', 'sh-item-body');
    const sub = el('span', 'sh-item-sub', readings.length ? '' : deviceSummary(pe));
    readings.forEach((r) => sub.appendChild(el('span', 'sh-reading', r)));
    if (readings.length) sub.title = readings.join(' · ');
    body.append(el('span', 'sh-item-name', unit.name), sub);
    const go = el('span', 'sh-item-go'); go.innerHTML = SVG('<path d="M9 6l6 6-6 6"/>');
    b.append(ico, body);
    if (!readings.length) b.append(el('span', 'sh-item-badge', String(unit.entities.length)));
    b.append(go);
    b.addEventListener('click', () => openDevice(unit.id));
    return b;
  }

  return { emptyCard, buildItem, deviceCard };
};
