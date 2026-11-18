// The choices of the deck editor for what lives on the PC and in the dashboard: a Claude project, a
// dashboard page, an app (playing, or with a window open), a Store app, an audio device.
'use strict';

window.DeckEditorAppPick = (wrapper) => {
    const { audioApps, audioDevices, claudeProjects, enhanceSelects, input, runningApps, storeApps, t } = wrapper;

    // A param control for the claudeProject kind: a dropdown of the projects a
    // run may be started in, stored by id. The list is the server's — the same
    // one the touchscreen panel offers, built from Claude Code's own history —
    // and the key only ever carries the id, never a folder path. A typed field
    // is the fallback while the list can't be read, so a key configured earlier
    // keeps its project rather than silently losing it (mirrors wlChannel).
    function claudeProjectPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_claude_project');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      claudeProjects().then((items) => {
        if (!items || !items.length) return;
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

    // A param control for the dashboardPage kind: the three moves the page
    // shortcuts offer (next / previous / back) plus every page of THIS layout,
    // stored by page id. Pages are per device, so a typed field stands in when
    // the list is not reachable, and an id this layout lacks stays selectable
    // rather than being rewritten to something else.
    function dashboardPageControl(step, name) {
      const pages = (window.DashboardPages && typeof window.DashboardPages.list === 'function')
        ? window.DashboardPages.list() : [];
      const cur = step.params[name] || '';
      if (!pages.length) {
        const txt = input('text', cur);
        txt.placeholder = t('deck_param_page');
        const writeTxt = () => { step.params[name] = txt.value; };
        txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
        return txt;
      }
      const items = ['next', 'prev', 'back'].map((m) => ({ value: m, label: t('settings_pagehk_move_' + m) }))
        .concat(pages.map((pg) => ({ value: pg.id, label: pg.label })));
      if (cur && !items.some((it) => it.value === cur)) items.push({ value: cur, label: cur });
      const wrap = document.createElement('div');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
      sel.value = cur || items[0].value;
      step.params[name] = sel.value;
      sel.addEventListener('change', () => { step.params[name] = sel.value; });
      wrap.appendChild(sel);
      enhanceSelects(wrap);
      return wrap;
    }

    // A param control for the audioApp kind. The text field is the source of truth
    // (the user can type ANY process name, e.g. "spotify" or "discord", even for an
    // app that isn't currently playing). A quick-pick dropdown of the apps that ARE
    // currently producing audio is added alongside as a convenience: choosing one
    // fills the text field. Stores the process name (proc), not the display name.
    function appPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_app');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      audioApps().then((items) => {
        if (!items || !items.length) return;   // nothing playing → typed field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const ph = document.createElement('option'); ph.value = '';
        ph.setAttribute('data-i18n', 'deck_opt_apppick'); ph.textContent = t('deck_opt_apppick');
        sel.appendChild(ph);
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        const cur = step.params[name] || '';
        sel.value = items.some((it) => it.value === cur) ? cur : '';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          txt.value = sel.value;            // mirror the pick into the editable field
          step.params[name] = sel.value;
        });
        wrap.appendChild(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the runningApp kind (the closeApp key): the same typed
    // field plus quick pick as audioApp, the pick listing the apps with a window
    // open now, so an app that is closed at the moment can still be typed.
    function runningAppPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_app');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      runningApps().then((items) => {
        if (!items?.length) return;
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const ph = document.createElement('option'); ph.value = '';
        ph.setAttribute('data-i18n', 'deck_opt_runningapp'); ph.textContent = t('deck_opt_runningapp');
        sel.appendChild(ph);
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = items.some((it) => it.value === step.params[name]) ? step.params[name] : '';
        sel.addEventListener('change', () => { if (sel.value) { txt.value = sel.value; step.params[name] = sel.value; } });
        wrap.appendChild(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the storeApp kind: a dropdown of installed Store/UWP apps
    // (value = AppUserModelID, label = friendly name). Pure dropdown — the AUMID is
    // cryptic, so it isn't typed by hand. A previously-saved app that is no longer
    // listed (uninstalled) is kept as the current option so the key isn't silently
    // cleared. The list arrives from /apps/store (Get-StartApps, UWP only).
    function storeAppPickControl(step, name) {
      const wrap = document.createElement('div');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const ph = document.createElement('option'); ph.value = '';
      ph.setAttribute('data-i18n', 'deck_opt_storeapp'); ph.textContent = t('deck_opt_storeapp');
      sel.appendChild(ph);
      sel.addEventListener('change', () => { step.params[name] = sel.value; });
      wrap.appendChild(sel);
      storeApps().then((items) => {
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) {
          const o = document.createElement('option'); o.value = cur; o.textContent = cur; sel.appendChild(o);
        }
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur;
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the audioDevice kind. A pure dropdown, with no typed
    // field beside it: unlike audioApp — where any process name is a legitimate
    // target, playing or not — the server resolves this value against the LIVE
    // output enumeration and refuses anything that is not in it. A text box here
    // could only ever hold something that fails, which is exactly what it did.
    //
    // A value already saved but not in the list right now (the headset is
    // unplugged) is kept as its own option rather than dropped: opening the
    // editor must not quietly erase a key that works whenever the device is
    // back.
    function audioDevicePickControl(step, name) {
      const wrap = document.createElement('div');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const ph = document.createElement('option'); ph.value = '';
      ph.setAttribute('data-i18n', 'deck_opt_devicepick'); ph.textContent = t('deck_opt_devicepick');
      sel.appendChild(ph);
      sel.addEventListener('change', () => { step.params[name] = sel.value; });
      wrap.appendChild(sel);
      audioDevices().then((items) => {
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) {
          const o = document.createElement('option'); o.value = cur;
          o.textContent = t('deck_opt_device_missing', 'Saved device (not connected)');
          sel.appendChild(o);
        }
        items.forEach((it) => {
          const o = document.createElement('option'); o.value = it.value;
          o.textContent = it.isDefault ? (it.label + ' • ' + t('deck_opt_device_current', 'current')) : it.label;
          sel.appendChild(o);
        });
        sel.value = cur;
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    return {
      claudeProjectPickControl, dashboardPageControl, appPickControl, storeAppPickControl,
      audioDevicePickControl, runningAppPickControl,
    };
};
