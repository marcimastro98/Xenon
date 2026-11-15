// The choices of the deck editor for things around the PC: a lighting effect, a Home Assistant
// entity, a Wave Link channel, a light device and its part.
'use strict';

window.DeckEditorDevicePick = (wrapper) => {
    const {
      enhanceSelects, haEntities, input, lightDevices, lightingLists, signalRgbEffects, t, wlChannels,
    } = wrapper;

    // A param control for the signalRgbEffect kind: a searchable dropdown of the
    // user's installed SignalRGB effects (the list can be long → data-cs-search).
    // A typed field is the fallback while the list is empty/loading, so an already
    // assigned effect is never lost (mirrors sbCodeTriggerPickControl).
    function signalRgbEffectPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_effect');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      signalRgbEffects().then((items) => {
        if (!items || !items.length) return;   // off/absent → typed effect field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        sel.setAttribute('data-cs-search', '');
        sel.setAttribute('data-cs-search-placeholder', t('deck_param_effect'));
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // effect list arrived → style + search-enable its dropdown
      }).catch(() => {});
      return wrap;
    }

    // A param control for the haEntity kind: a dropdown of the user's live Home
    // Assistant entities ({value:entity_id, label:"Area › Name"}), stored by
    // entity_id. A typed field is the fallback while HA is unreachable, so an
    // already-assigned entity is never lost when offline (mirrors discordChannel).
    function haEntityPickControl(step, name, domain) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_entity');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      haEntities().then((items) => {
        // Capability-aware: a domain-scoped action (haMedia, haCover…) only lists
        // entities of that domain, so the picker shows the RIGHT devices.
        if (domain) items = items.filter((it) => String(it.value).startsWith(domain + '.'));
        if (!items || !items.length) return;   // offline / none of this kind → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // entity list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the wlChannel kind: a dropdown of the user's live Wave
    // Link mixer channels ({value:mixId, label}), stored by mixId. A typed field is
    // the fallback while Wave Link is unreachable, so an assigned channel survives
    // offline (mirrors haEntityPickControl).
    function wlChannelPickControl(step, name) {
      return wlPickControl(step, name, wlChannels, t('deck_param_mixId'));
    }

    // The shape all four Wave Link pickers share. `load` resolves to
    // [{value,label}]; an empty list leaves the typed field in place so a key
    // configured earlier keeps its id while Wave Link is closed. A stored value
    // the live list does not contain is PREPENDED rather than dropped, for the
    // same reason: opening the editor must never silently retarget a key.
    function wlPickControl(step, name, load, placeholder) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = placeholder || '';
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      load().then((items) => {
        if (!items || !items.length) return;   // offline / none → typed field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the lightDevice kind: a dropdown of the user's lighting
    // devices ({value:id, label}), stored by device id. A typed field is the
    // fallback while no lighting is configured, so an assigned id survives offline
    // (mirrors wlChannelPickControl).
    function lightDevicePickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_device');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      lightDevices().then((items) => {
        if (!items || !items.length) return;   // none → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the lightPart kind: one dropdown of every part of every
    // device with a lighting map (Fan 3, Pump, Strip 1…), named as the map names
    // them. Writes two params: the device id and the part's index in its map.
    function lightPartPickControl(step) {
      const wrap = document.createElement('div');
      const note = document.createElement('p'); note.className = 'deck-ed-hint';
      note.setAttribute('data-i18n', 'deck_part_none'); note.textContent = t('deck_part_none');
      wrap.appendChild(note);
      lightingLists().then(({ parts }) => {
        const names = (segs) => (window.LightingMap && window.LightingMap.partLabels
          ? window.LightingMap.partLabels(segs) : segs.map((s, i) => s.name || String(i + 1)));
        const items = [];
        parts.forEach((d) => names(d.segments).forEach((label, i) => items.push({ device: d.device, part: i, label: `${d.label} · ${label}` })));
        if (!items.length) return;   // nothing with parts → the note stays
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        items.forEach((it, k) => { const o = document.createElement('option'); o.value = String(k); o.textContent = it.label; sel.appendChild(o); });
        const at = items.findIndex((it) => it.device === step.params.device && it.part === Number(step.params.part));
        const pick = (k) => { step.params.device = items[k].device; step.params.part = items[k].part; };
        sel.value = String(at >= 0 ? at : 0);
        pick(Number(sel.value));
        sel.addEventListener('change', () => pick(Number(sel.value)));
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    return {
      signalRgbEffectPickControl, haEntityPickControl, wlChannelPickControl, wlPickControl,
      lightDevicePickControl, lightPartPickControl,
    };
};
