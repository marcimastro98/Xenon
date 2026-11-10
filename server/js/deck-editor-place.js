'use strict';
// Key editor: the On the screen card (What it does tab). One button puts this key
// on the screen as a small button that stays there. The person pressing it here is
// their agreement to what the key does now, so it answers to the first tap; an edit
// saved later asks again (server/deck-press.js). Never on a phone: the button is
// pressed at the PC. window.DeckEditorPlace.
(function () {
  const base = () => (typeof SERVER !== 'undefined' ? SERVER : '');

  function post(path, body) {
    return fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json()).catch(() => null);
  }

  async function place(id) {
    const res = await post('/actions/run', { type: 'layerKey', key: id, surface: 'overlay', position: 'top-right' });
    if (!(res && res.ok)) return res || { ok: false };
    return post('/deck/press', { id: res.id, accept: res.fp });
  }

  function failText(t, res) {
    if (res && res.error === 'too_many') return t('layer_edit_add_full');
    if (res && res.error === 'no_action') return t('deck_place_no_action');
    return t('layer_edit_add_failed');
  }

  // The card, or null where a key cannot go on the screen: one not saved yet has no
  // id to point at, a phone has no screen of the PC's, and the shell may have no layers.
  function buildCard({ t, section }, existing, caps) {
    const id = existing && existing.id;
    if (typeof id !== 'string' || !id || window.__xenonRemote) return null;
    if (caps && caps.layers === false) return null;
    const el = section('deck_place_title');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'deck-ed-btn';
    btn.textContent = t('deck_place_button');
    const line = document.createElement('div');
    line.className = 'deck-ed-hint';
    line.setAttribute('aria-live', 'polite');
    line.textContent = t('deck_place_hint');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await place(id);
      btn.disabled = false;
      const ok = !!res && res.ok === true;
      line.textContent = ok ? t('deck_place_done') : failText(t, res);
      line.classList.toggle('is-bad', !ok);
    });
    el.append(btn, line);
    return el;
  }

  window.DeckEditorPlace = Object.freeze({ buildCard });
})();
