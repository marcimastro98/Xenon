// The panel that opens over the page for one device: built once, drawn again from live state only
// when something changed and never under a held slider, closed by its button, a tap outside or
// Escape.
'use strict';

window.SmartHomeSheet = (wrapper) => {
  const { SVG, homeState, iconFor, buildSheetBody, buildDeviceBody } = wrapper;

  const { t, isOn } = window.SmartHomeStateWords;
  const { primaryEntity } = window.SmartHomeUnits;
  const { el } = window.SmartHomePieces;

  function entityById(id) { return homeState.state.entities.find((x) => x.id === id) || null; }

  // ---- sheet shell + lifecycle ----------------------------------------------
  function ensureSheet() {
    if (homeState.sheetEl) return homeState.sheetEl;
    const ov = el('div', 'sh-sheet-overlay'); ov.hidden = true;
    const sheet = el('div', 'sh-sheet');
    const head = el('div', 'sh-sheet-head');
    const ico = el('span', 'sh-sheet-ico');
    const titles = el('div', 'sh-sheet-titles');
    const title = el('div', 'sh-sheet-title');
    const sub = el('div', 'sh-sheet-sub');
    titles.append(title, sub);
    const close = el('button', 'sh-sheet-close'); close.type = 'button'; close.setAttribute('aria-label', t('close'));
    close.innerHTML = SVG('<path d="M6 6l12 12M18 6L6 18"/>');   // static, trusted SVG
    close.addEventListener('click', closeSheet);
    head.append(ico, titles, close);
    const scroll = el('div', 'sh-sheet-scroll');
    sheet.append(head, scroll);
    ov.appendChild(sheet);
    ov.addEventListener('click', (ev) => { if (ev.target === ov) closeSheet(); });
    document.body.appendChild(ov);
    homeState.sheetEl = ov; homeState.sheetBodyEl = scroll;
    homeState.sheetEl._ico = ico; homeState.sheetEl._title = title; homeState.sheetEl._sub = sub;
    return ov;
  }

  function deviceEntitiesById(devId) { return homeState.state.entities.filter((x) => x.device === devId); }

  // Render the open sheet from live state — a single entity, or all the entities of
  // one physical device. Skips a rebuild when nothing changed (idempotent sig).
  function renderSheet() {
    if (homeState.sheetKind === 'device') {
      const ents = deviceEntitiesById(homeState.sheetId);
      if (!ents.length) { closeSheet(); return; }
      const sig = 'dev|' + homeState.sheetId + '|' + JSON.stringify(ents);
      if (sig === homeState.sheetSig) return;
      homeState.sheetSig = sig;
      const pe = primaryEntity(ents);
      const name = ents[0].deviceName || pe.name;
      homeState.sheetEl._ico.innerHTML = iconFor(pe);   // static, trusted SVG
      homeState.sheetEl._ico.classList.toggle('is-on', ents.some((x) => isOn(x)));
      homeState.sheetEl._title.textContent = name;
      homeState.sheetEl._sub.textContent = (pe.area && pe.area !== '~') ? pe.area : t('smarthome_title');
      homeState.sheetBodyEl.replaceChildren(buildDeviceBody(ents, name));
      return;
    }
    const e = entityById(homeState.sheetId);
    if (!e) { closeSheet(); return; }
    const sig = 'ent|' + e.id + '|' + JSON.stringify(e);
    if (sig === homeState.sheetSig) return;             // unchanged → don't rebuild under the user
    homeState.sheetSig = sig;
    homeState.sheetEl._ico.innerHTML = iconFor(e);      // static, trusted SVG
    homeState.sheetEl._ico.classList.toggle('is-on', isOn(e));
    homeState.sheetEl._title.textContent = e.name;
    homeState.sheetEl._sub.textContent = (e.area && e.area !== '~') ? e.area : t('smarthome_title');
    homeState.sheetBodyEl.replaceChildren(buildSheetBody(e));
  }

  function openTarget(kind, id) {
    homeState.sheetKind = kind; homeState.sheetId = id; homeState.sheetSig = '';
    ensureSheet();
    renderSheet();
    if (homeState.sheetId === null) return;             // renderSheet closed it (nothing to show)
    homeState.sheetEl.hidden = false;
    requestAnimationFrame(() => { if (homeState.sheetEl) homeState.sheetEl.classList.add('is-open'); });
    document.addEventListener('keydown', onSheetKey);
  }
  function openSheet(id) { if (entityById(id)) openTarget('entity', id); }
  function openDevice(devId) { if (deviceEntitiesById(devId).length) openTarget('device', devId); }

  function closeSheet() {
    if (!homeState.sheetEl) return;
    homeState.sheetId = null; homeState.sheetDragging = false;
    homeState.sheetEl.classList.remove('is-open');
    document.removeEventListener('keydown', onSheetKey);
    const ov = homeState.sheetEl;
    setTimeout(() => { if (homeState.sheetId === null) ov.hidden = true; }, 220);
  }

  function onSheetKey(ev) { if (ev.key === 'Escape') closeSheet(); }

  // Reflect live state into an open sheet (called on every paint). Rebuild is
  // skipped mid-drag (so a held slider never jumps) and when nothing changed.
  function syncSheet() {
    if (homeState.sheetId === null || !homeState.sheetEl || homeState.sheetEl.hidden || homeState.sheetDragging) return;
    renderSheet();
  }

  return { entityById, openSheet, openDevice, syncSheet };
};
