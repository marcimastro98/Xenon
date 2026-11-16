// The icon of a search result: a drawn glyph for its kind of file at once, swapped for the app's
// own icon when the server has one, each icon asked for once.
'use strict';

(() => {
  const { KIND_OF_EXT, ICON_PATHS } = window.SpotlightFileKinds;

  function iconFor(r) {
    const ext = String(r.ext || '').toLowerCase();
    const kind = ext === '' ? 'folder' : (KIND_OF_EXT[ext] || 'file');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[kind] || ICON_PATHS.file);
    svg.appendChild(path);
    svg.classList.add('spot-icon', 'spot-icon-' + kind);
    return svg;
  }

  // Real app logos: an app/exe/lnk result upgrades its generic glyph to the
  // real icon, fetched by opaque id from /search/icon and cached per app for
  // the session. Two races handled explicitly (both were live bugs — the icon
  // showed once, then a delete-and-retype pinned the glyph forever):
  //  * one fetch per key at a time; every re-render only re-registers the
  //    LATEST glyph element + result id, so the response lands on the row the
  //    user is looking at, not a disconnected one;
  //  * only SUCCESSES are cached. A late response for a stale id (evicted
  //    server-side between renders) must never overwrite a good icon with
  //    "no icon" — on an empty answer we retry once with the freshest id.
  // Shared across instances (overlay + widget tiles): the cache is per app,
  // not per surface.
  const appIcons = new Map();     // key → data URL (successes only)
  const appIconWait = new Map();  // key → { host, id } of the latest render
  // `force` is the synchronous cache-hit path: it runs while the row is still
  // being BUILT (it gets appended to the list at the end of the render loop),
  // so isConnected is false by construction there — the guard is only for
  // ASYNC responses, where a disconnected host means a superseded render.
  function swapIconInto(el, src, force) {
    if (!el || (!force && !el.isConnected)) return;
    const img = document.createElement('img');
    img.className = 'spot-icon spot-icon-app';
    img.alt = '';
    img.src = src;
    el.replaceWith(img);
  }
  function requestIcon(key, id) {
    fetch('/search/icon?id=' + encodeURIComponent(id))
      .then((res) => res.json())
      .then((out) => {
        const icon = out && out.ok && out.icon && String(out.icon).startsWith('data:image/') ? String(out.icon) : null;
        const wait = appIconWait.get(key);
        if (icon) {
          if (appIcons.size > 300) appIcons.clear();
          appIcons.set(key, icon);
          appIconWait.delete(key);
          if (wait) swapIconInto(wait.host, icon);
          return;
        }
        if (wait && wait.id !== id) { requestIcon(key, wait.id); return; }
        appIconWait.delete(key);
      })
      .catch(() => { appIconWait.delete(key); });
  }
  function upgradeAppIcon(r, host) {
    const ext = String(r.ext || '').toLowerCase();
    if (!r.app && ext !== 'exe' && ext !== 'lnk') return;
    const key = r.app ? 'app:' + (r.name || '') : (r.dir || '') + '\\' + (r.name || '');
    const hit = appIcons.get(key);
    if (hit) { swapIconInto(host, hit, true); return; }
    const pending = appIconWait.has(key);
    appIconWait.set(key, { host, id: r.id });
    if (!pending) requestIcon(key, r.id);
  }

  window.SpotlightIcons = { iconFor, upgradeAppIcon };
})();
