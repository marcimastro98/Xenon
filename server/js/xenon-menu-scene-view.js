'use strict';

// The live preview above "Scene used" in the menu window: the scene page
// (scene.html, key preview:menu) in a small frame, showing the scene under the
// pointer and otherwise the chosen one. The menu rebuilds its rows after every
// change and re-inserting a frame reloads it, so the one frame waits in a hidden
// holder during a rebuild (`hold`, then `settle`) and keeps running.
(function () {
  const PREVIEW_KEY = 'preview:menu';
  // Passing over a row of scenes must not start each one in turn.
  const POINT_DELAY_MS = 180;

  function previewUrl(server, id) {
    return `${server}/scene?key=${encodeURIComponent(PREVIEW_KEY)}&scene=${encodeURIComponent(id)}`;
  }

  function create({ el, doc, server, move }) {
    const put = move || ((parent, node) => parent.insertBefore(node, null));
    let frame = null;
    let holder = null;
    let box = null;
    let chosen = '';
    let wanted = '';
    let timer = null;

    function makeFrame() {
      const f = el('iframe', 'xm-scene-frame');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.addEventListener('load', () => f.classList.add('is-ready'));
      return f;
    }

    function load(id) {
      if (!frame || frame.dataset.scene === id) return;
      frame.dataset.scene = id;
      frame.classList.remove('is-ready');
      frame.src = previewUrl(server, id);
    }

    function point(id) {
      wanted = id;
      clearTimeout(timer);
      timer = setTimeout(() => load(wanted), POINT_DELAY_MS);
    }

    function follow(button, id) {
      const value = String(id);
      const enter = () => point(value);
      const leave = () => point(chosen);
      button.addEventListener('pointerenter', enter);
      button.addEventListener('focus', enter);
      button.addEventListener('pointerleave', leave);
      button.addEventListener('blur', leave);
    }

    function slot(value) {
      const id = String(value);
      if (id !== chosen) { chosen = id; wanted = id; }
      box = el('div', 'xm-scene-view');
      return { box, follow };
    }

    function hold() {
      box = null;
      if (!frame || !frame.isConnected) return;
      if (!holder) {
        holder = el('div', 'xm-scene-holder');
        holder.hidden = true;
        doc.body.appendChild(holder);
      }
      put(holder, frame);
    }

    function drop() {
      clearTimeout(timer);
      if (frame) frame.remove();
      if (holder) holder.remove();
      frame = null;
      holder = null;
      chosen = '';
      wanted = '';
    }

    // After a rebuild: into the new row, or gone with the page that had it.
    function settle() {
      if (!box || !box.isConnected) { drop(); return; }
      if (!frame) frame = makeFrame();
      put(box, frame);
      load(wanted);
    }

    return { slot, hold, settle };
  }

  const api = { create, previewUrl, PREVIEW_KEY, POINT_DELAY_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.XenonMenuSceneView = api;
})();
