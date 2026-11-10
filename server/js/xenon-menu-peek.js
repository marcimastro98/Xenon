'use strict';

// While a widget's screen is open in the menu, that widget stays on the real screen even
// if its rule hides it (server/layers-peek.js). The server lets go by itself when the
// repeats stop, so they stop with the page out of sight.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuPeek = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const REPEAT_MS = 8000;

  // post(path, body) answers { ok }; `onRefused` runs once on a device that may not do it.
  function create({ post, onRefused = () => {}, doc = null, setTimer = setInterval, clearTimer = clearInterval }) {
    let id = null;
    let timer = null;
    let refused = false;

    const seen = () => !doc || doc.visibilityState !== 'hidden';

    async function tell(value) {
      if (refused) return;
      const reply = await Promise.resolve(post('/screen-menu', { peek: value })).catch(() => ({ ok: true }));
      if (reply && reply.ok) return;
      refused = true;
      onRefused();
    }

    function stopRepeat() {
      if (timer) clearTimer(timer);
      timer = null;
    }

    function repeat() {
      stopRepeat();
      if (!id || !seen()) return;
      timer = setTimer(() => tell(id), REPEAT_MS);
    }

    function show(next) {
      const want = next || null;
      if (want === id) return;
      id = want;
      tell(id);
      repeat();
    }

    function onVisibility() {
      if (!id) return;
      tell(seen() ? id : null);
      repeat();
    }
    if (doc) doc.addEventListener('visibilitychange', onVisibility);

    function stop() {
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      show(null);
    }

    return { show, stop, held: () => !!id && !refused };
  }

  return { create, REPEAT_MS };
});
