// "Put on screen" right after an install: the step between having a widget and
// seeing it, for anyone whose Xenon draws widgets on the screen. The Store and
// the Maker's link both end in the import (js/preset-share.js): its "installed"
// toast asks here for the button (onScreenOption), so there is one toast and not
// two. The Maker's "Put on screen" link already asked (`place`), so it goes
// straight on screen; anything else is offered, never done unasked.
(function () {
  // The same spot as the Xenon menu's Add list (server/xenon-menu.js).
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

  // With Solo widget the screen is the only place there is, so `only` tells the
  // toast to drop its page button and say this instead.
  async function onScreenOption(ids) {
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
        onClick: () => (many ? post('/screen-menu', { open: true, section: 'widgets' }) : place(ids[0])),
      },
    };
  }

  async function onInstalled(event) {
    const d = (event && event.detail) || {};
    if (d.place !== true) return;
    const scenes = Array.isArray(d.sceneIds) ? d.sceneIds : [];
    const ids = (Array.isArray(d.widgetIds) ? d.widgetIds : []).filter((id) => !scenes.includes(id));
    if (ids.length !== 1) return;
    if (await drawsOnScreen()) await place(ids[0]);
    else toast({ type: 'info', title: d.name, message: tr('place_needs_app', 'Installed. Open the Xenon app to put it on your screen.') });
  }

  window.addEventListener('xenon-content-installed', onInstalled);
  window.PlaceInstalled = { onScreenOption };
})();
