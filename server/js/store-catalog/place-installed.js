// "Put on screen" right after an install: the step between having a widget and
// seeing it, for anyone whose Xenon draws widgets on the screen. The Store and
// the Maker's link both end in the import (js/presets/preset-share.js): its "installed"
// toast asks here for the button (onScreenOption), so there is one toast and not
// two. The Maker's "Put on screen" link already asked (`place`), so it goes
// straight on screen. One widget imported by itself goes into use at once, and a
// pump screen's style onto the pump (useInstalled); a package's other widgets are offered.
(function () {
  // The same spot as the Xenon menu's Add list (server/menu/xenon-menu.js).
  const SPOT = { surface: 'desktop', position: 'top-right', size: 'medium' };

  const tr = (key, fallback) => {
    const said = typeof t === 'function' ? t(key) : key;
    return said && said !== key ? said : fallback;
  };

  async function post(path, body) {
    try {
      const res = await fetch(SERVER + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      console.warn('[place-installed] ' + path + ' did not answer', e);
      return null;
    }
  }

  // Asked of the server, not the shell's caps: the Maker's link opens in a
  // browser tab, which has no shell of its own but can still place the widget.
  async function drawsOnScreen() {
    if (window.__xenonRemote) return false;
    if (typeof isLayerPage === 'function' && isLayerPage() && !isSheetPage()) return false;
    try {
      const res = await fetch(SERVER + '/actions/catalog', { cache: 'no-store' });
      const data = await res.json();
      return !!data && !!data.capabilities && data.capabilities.layers === true;
    } catch (e) {
      return false;
    }
  }

  const toast = (o) => { if (window.XenonToast) window.XenonToast.show(o); };

  async function place(id) {
    const done = await post('/actions/run', { type: 'layerPlace', widget: id, ...SPOT });
    if (!done || done.ok !== true) {
      const code = (done && done.error) || 'failed';
      toast({
        type: 'error',
        title: tr('place_failed_title', 'Could not put it on the screen'),
        message: window.DeckErrorText ? window.DeckErrorText.describe(code, tr) : code,
      });
      return;
    }
    toast({
      type: 'success',
      title: tr('place_done_title', 'On your screen'),
      message: tr('place_done_msg', 'Top right. You can move it anywhere.'),
      duration: 8000,
      actions: [{
        label: tr('place_move_btn', 'Move'), primary: true,
        onClick: () => post('/actions/run', { type: 'layersEdit', mode: 'on' }),
      }],
    });
  }

  // A widget its creator kept to the top bar (manifest `tile: false`) is never put on a screen,
  // nor a pump screen's style (`pumpStyle`): the pump draws it.
  function placeable(ids) {
    const CW = window.CustomWidget;
    const pkgs = CW && typeof CW.cachedPackages === 'function' ? CW.cachedPackages() : [];
    return ids.filter((id) => !pkgs.some((p) => p && p.id === id && (p.tile === false || p.pumpStyle === true)));
  }

  // A pump screen's style, approved, becomes the style of every pump screen it fits, with Undo
  // (each screen back to the style it had). No pump it fits: where it is chosen, as before.
  async function usePumpStyle(pkg) {
    // The shapes from the package itself: the approval may still be on its way to the server.
    const shapes = Array.isArray(pkg.pump) ? pkg.pump : [];
    const got = await post('/actions/run', { type: 'pumpGet' });
    const screens = got && Array.isArray(got.screens) ? got.screens.filter((v) => v && shapes.includes(v.seen?.shape || 'round')) : [];
    const style = 'widget:' + pkg.id;
    if (!screens.length) {
      toast({ type: 'success', duration: 14000, title: tr('preset_widget_ready', '{name} is installed').replace('{name}', String(pkg.name)),
        message: tr('place_pump_style_msg', "A style for the pump's screen: choose it in Screens → the pump → Look → Style."),
        actions: window.__xenonRemote ? [] : [{ label: tr('place_pump_style_btn', 'Open Screens'), primary: true, onClick: () => post('/screen-menu', { open: true, section: 'screens' }) }] });
      return;
    }
    // An update of the style already in use changes nothing on the pump: it just says it is there.
    // A new style also takes the ring's moves (Lights → How they move), or a ring set to one
    // effect would hide every light the style gives it; Undo gives both back.
    // [screen, its style, its ring's move when the style does not move it yet]
    const before = screens.filter((v) => v.style !== style).map((v) => [v.screen, v.style || 'xenon', v.leds?.move && v.leds.move !== 'style' ? v.leds.move : null]);
    if (!before.length) {
      toast({ type: 'success', duration: 8000, title: tr('preset_widget_ready', '{name} is installed').replace('{name}', String(pkg.name)), message: tr('place_pump_style_on_msg', 'You can change it in Screens → the pump → Look.') });
      return;
    }
    const patch = (st, move) => JSON.stringify(move ? { style: st, leds: { move } } : { style: st });
    for (const [screen, , move] of before) await post('/actions/run', { type: 'pumpSet', screen, patch: patch(style, move ? 'style' : null) });
    toast({ type: 'success', duration: 14000, title: tr('place_pump_style_on', "{name} draws your pump's screen").replace('{name}', String(pkg.name)),
      message: tr('place_pump_style_on_msg', 'You can change it in Screens → the pump → Look.'),
      actions: [{ label: tr('ai_undo', 'Undo'), onClick: () => before.forEach(([screen, was, move]) => { post('/actions/run', { type: 'pumpSet', screen, patch: patch(was, move) }); }) }] });
  }

  // Installed means in use. Pump screen styles go on the pump once approved (the approval is
  // asked here, so the import asks nothing else for them); one other widget goes on the page in
  // view through the same path as one Bit made (a page of its own when this one is full), or on
  // the screen with Solo widget. The Maker's link already put its widget on screen.
  // `fallback` runs the old offer where nothing is placed: a package's other widgets (its pages
  // already placed what its author meant; their approvals are asked by the import), no page here.
  function useInstalled(pkgs, { link = false, single = false } = {}, fallback = () => {}) {
    const CW = window.CustomWidget;
    const styles = pkgs.filter((p) => p && p.pumpStyle === true);
    const rest = pkgs.filter((p) => p && p.pumpStyle !== true);
    styles.forEach((pkg) => {
      if (CW && typeof CW.packageGranted === 'function' && !CW.packageGranted(pkg) && typeof CW.requestGrant === 'function') CW.requestGrant(pkg, () => usePumpStyle(pkg));
      else usePumpStyle(pkg);
    });
    if (!rest.length || link) return;
    if (!single || rest.length > 1 || !CW) { fallback(rest); return; }
    putToUse(CW, rest[0], fallback);
  }

  async function putToUse(CW, pkg, fallback) {
    const settings = typeof hubSettings === 'undefined' ? null : hubSettings;
    const solo = !!window.UsageMode && !!settings && window.UsageMode.widgetsOnly(settings.usageMode);
    if (solo && placeable([pkg.id]).length && (await drawsOnScreen())) { await place(pkg.id); return; }
    const inst = typeof CW.placeCreated === 'function' ? await CW.placeCreated(pkg.id) : null;
    if (!inst) { fallback([pkg]); return; }
    toast({ type: 'success', duration: 8000, title: tr('place_page_done', '{name} is on this page').replace('{name}', String(pkg.name)),
      message: tr('place_page_done_msg', 'Move it or take it off in Layout mode.') });
  }

  // With Solo widget the screen is the only place there is, so `only` tells the
  // toast to drop its page button and say this instead.
  async function onScreenOption(all) {
    const ids = placeable(all);
    if (!ids.length || !(await drawsOnScreen())) return null;
    const many = ids.length > 1;
    const settings = typeof hubSettings === 'undefined' ? null : hubSettings;
    return {
      only: !!window.UsageMode && !!settings && window.UsageMode.widgetsOnly(settings.usageMode),
      message: many
        ? tr('place_many_msg', 'Installed. Choose what to put on the screen.')
        : tr('place_offer_msg', 'Installed. Want it on your screen?'),
      action: {
        label: many ? tr('place_many_btn', 'Choose') : tr('place_offer_btn', 'Put on screen'),
        onClick: () => (many ? post('/screen-menu', { open: true, section: 'screens' }) : place(ids[0])),
      },
    };
  }

  async function onInstalled(event) {
    const d = (event && event.detail) || {};
    if (d.place !== true) return;
    const scenes = Array.isArray(d.sceneIds) ? d.sceneIds : [];
    const ids = placeable((Array.isArray(d.widgetIds) ? d.widgetIds : []).filter((id) => !scenes.includes(id)));
    if (ids.length !== 1) return;
    if (await drawsOnScreen()) await place(ids[0]);
    else toast({ type: 'info', title: d.name, message: tr('place_needs_app', 'Installed. Open the Xenon app to put it on your screen.') });
  }

  window.addEventListener('xenon-content-installed', onInstalled);
  window.PlaceInstalled = { onScreenOption, useInstalled };
})();
