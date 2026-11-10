'use strict';

// The row of the Xenon menu that renames or deletes the selected page of widgets.
// It holds what is being typed, so a redraw of the menu takes nothing away. Deleting
// a page that has widgets asks once, saying how many go with it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuPageEdit = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const IDLE = Object.freeze({ page: '', mode: '', name: '' });

  // ctx: { el, button, tt, fill, rowShell, perform, redraw, root }
  function create(ctx) {
    const { el, button, tt, fill, rowShell, perform, redraw, root } = ctx;
    let state = IDLE;
    let saving = false;

    const reset = () => { state = IDLE; };
    const start = (r, mode) => { state = { page: r.page, mode, name: r.name }; redraw(); };
    const cancel = () => { reset(); redraw(); };
    const askRemove = (r) => (r.widgets ? start(r, 'confirm') : perform(r, r.remove));
    const secondary = (label, onClick) => {
      const b = button('ui-btn ui-btn--secondary xm-act', label);
      b.addEventListener('click', onClick);
      return b;
    };

    async function save(r) {
      const ok = await perform(r, { run: { ...r.rename, name: state.name.trim() } });
      if (ok) reset();
    }

    function nameField(r) {
      const field = el('input', 'xm-search xm-page-name');
      field.type = 'text';
      field.maxLength = r.max;
      field.value = state.name;
      field.setAttribute('aria-label', tt('layer_page_rename'));
      field.addEventListener('input', () => { state = { ...state, name: field.value }; });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(r); }
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      });
      return field;
    }

    function acts(...buttons) {
      const box = el('div', 'xm-acts');
      box.append(...buttons);
      return box;
    }

    function drawRename(r) {
      const li = rowShell(r, 'xm-row--stack');
      li.append(nameField(r), acts(secondary(tt('deck_opt_save'), () => save(r)), secondary(tt('capg_cancel'), cancel)));
      return li;
    }

    function confirmActs(r) {
      const sure = secondary(fill(tt('layer_page_delete_confirm'), { n: r.widgets }), () => perform(r, r.remove).then(reset));
      return acts(sure, secondary(tt('capg_cancel'), cancel));
    }

    function drawConfirm(r) {
      const li = rowShell(r, 'xm-row--two');
      li.append(confirmActs(r));
      return li;
    }

    function drawIdle(r) {
      const li = rowShell(r, 'xm-row--two');
      li.append(acts(secondary(tt('layer_page_rename'), () => start(r, 'rename')), secondary(tt('layer_page_delete'), () => askRemove(r))));
      return li;
    }

    function draw(r) {
      if (state.page !== r.page) reset();
      if (state.mode === 'rename') return drawRename(r);
      return state.mode === 'confirm' ? drawConfirm(r) : drawIdle(r);
    }

    // Enter and leaving the field both land here; a redraw can end the field mid-save.
    async function saveName(r) {
      if (saving || state.name.trim() === r.name) return;
      saving = true;
      await save(r);
      saving = false;
    }

    function nameOnScreen(r, shown) {
      const field = el('input', 'xm-search xm-page-name');
      field.type = 'text';
      field.maxLength = r.max;
      field.value = state.name;
      field.placeholder = shown;
      field.addEventListener('input', () => { state = { ...state, name: field.value }; });
      field.addEventListener('blur', () => saveName(r));
      field.addEventListener('keydown', (e) => {
        // Leaving the field saves, and lets the menu redraw with the new name.
        if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        state = { ...state, name: r.name };
        field.value = r.name;
        field.blur();
      });
      const box = el('label', 'xm-pagefield');
      box.append(el('span', 'xm-sub', tt('xmenu_page_name')), field);
      return box;
    }

    // The page's own screen: the name saves itself, deleting sits apart at the bottom.
    function drawScreen(r, shown) {
      if (state.page !== r.page) state = { page: r.page, mode: '', name: r.name };
      const gone = el('div', 'xm-gone');
      gone.append(state.mode === 'confirm' ? confirmActs(r) : acts(secondary(tt('layer_page_delete'), () => askRemove(r))));
      return { name: nameOnScreen(r, shown), gone };
    }

    // After a redraw the field is new: put the cursor back in it, once, when renaming starts.
    function focusName() {
      const field = root.querySelector('.xm-page-name');
      if (field && root.ownerDocument.activeElement !== field) { field.focus(); field.select(); }
    }

    return {
      draw, drawScreen, reset, focusName,
      holds: () => state.mode === 'rename',
      typing: () => root.ownerDocument.activeElement === root.querySelector('.xm-page-name'),
    };
  }

  return { create };
});
