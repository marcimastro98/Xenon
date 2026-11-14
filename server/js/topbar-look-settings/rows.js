// How a row of the top bar's look settings is kept in step with the look: its control and the note
// under it, the names of the buttons, the choices of a row of options, whether the side rails hide
// by themselves, and the sample notification.
'use strict';

(() => {
  const seg = (prefix, values) => values.map((v) => [v, prefix + v.replace(/-/g, '_')]);

  // The edge rails of Minimal and None. A side that holds Settings or Layout
  // says so under its switch: the guard in TopbarLook.css keeps it on screen.
  const autoHide = () => typeof hubSettings === 'undefined' || !hubSettings || hubSettings.topbarRailsAutoHide !== false;

  // Names of the buttons for the accent list (keys shared with the button editor).
  const BUTTON_NAMES = {
    lock: 'topbar_btn_lock', ambient: 'topbar_btn_ambient', xenon: 'topbar_btn_xenon', search: 'topbar_btn_search',
    layout: 'topbar_btn_layout', settings: 'topbar_btn_settings', apps: 'topbar_btn_apps',
  };

  function syncNote(el, row, l) {
    const note = row.note && el.querySelector('.tbl-note');
    if (!note) return;
    const key = row.note(l);
    note.hidden = !key;
    if (key) { note.setAttribute('data-i18n', key); note.textContent = t(key); } else note.removeAttribute('data-i18n');
  }

  function syncRow(el, row, l) {
    el.hidden = typeof row.when === 'function' && !row.when(l);
    syncNote(el, row, l);
    if (el._tbSync) return el._tbSync(l);
    const control = el._tbControl;
    if (!control) return;
    if (control._tbSync) return control._tbSync(l);
    if (control.tagName === 'SELECT') {
      control.value = l[row.key];
      if (typeof control._csSync === 'function') control._csSync();
      return;
    }
    // A side that must stay cannot be switched off: its "Off" is greyed out and
    // the note under the name says why, instead of a choice that does nothing.
    const locked = row.note ? !!row.note(l) : false;
    for (const b of control.querySelectorAll('[data-tb-value]')) {
      const on = locked ? b.dataset.tbValue === 'show' : b.dataset.tbValue === l[row.key];
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = locked && b.dataset.tbValue === 'off';
    }
  }

  function testToast() {
    if (window.XenonToast) XenonToast.show({ type: 'info', title: t('tbl_toast_sample_title'), message: t('tbl_toast_sample') });
  }

  window.TopbarLookSettingsRows = { seg, autoHide, BUTTON_NAMES, syncRow, testToast };
})();
