// How the camera widget lays its cameras out and keeps them fresh: the grid and its shape, the
// order of the cameras, the angle and zoom of each, and the timer that pulls a new picture.
'use strict';

(() => {
  // Snapshot URL for a camera, resolved by its source. Both are loopback proxies
  // that hold the secret server-side and stream back JPEG bytes.
  const snapUrl = (cam) => (cam.source === 'ha'
    ? '/api/ha/camera/snapshot/' + encodeURIComponent(cam.id) + '?ts=' + Date.now()
    : '/api/unifiprotect/snapshot/' + encodeURIComponent(cam.id) + '?ts=' + Date.now());

  function readHubSettings() {
    try { return (typeof hubSettings !== 'undefined' && hubSettings) || {}; } catch (e) { return {}; }
  }

  // All client-side + persisted in settings.unifi; the server normalizer is the
  // authority (mirrored here for defaults). aspect maps to a CSS aspect-ratio value.
  const ASPECT_CSS = { '16:9': '16 / 9', '4:3': '4 / 3', '1:1': '1 / 1' };
  const ROTATIONS = [0, 90, 180, 270];
  const DEFAULT_REFRESH_MS = 1500;

  function layoutOf() {
    const u = readHubSettings().unifi || {};
    const cols = Number(u.columns);
    const ms = Number(u.refreshMs);
    return {
      columns: Number.isFinite(cols) ? Math.min(6, Math.max(0, Math.round(cols))) : 0,
      fit: u.fit === 'contain' ? 'contain' : 'cover',
      aspect: ASPECT_CSS[u.aspect] ? u.aspect : '16:9',
      order: Array.isArray(u.order) ? u.order : [],
      refreshMs: Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.round(ms))) : DEFAULT_REFRESH_MS,
      angles: (u.angles && typeof u.angles === 'object') ? u.angles : {},
    };
  }

  // The per-camera view adjustment (rotation + horizontal flip + digital zoom/pan),
  // resolved from the RIGHT store for the camera's source: UniFi transforms live in
  // settings.unifi.angles (keyed by console id), HA transforms in
  // settings.homeAssistant.camAngles (keyed by camera entity id).
  const MAX_ZOOM = 3;
  const clampPan = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(-100, n)) : 0; };

  function anglesFor(source) {
    const h = readHubSettings();
    if (source === 'ha') {
      const ha = h.homeAssistant || {};
      return (ha.camAngles && typeof ha.camAngles === 'object') ? ha.camAngles : {};
    }
    const u = h.unifi || {};
    return (u.angles && typeof u.angles === 'object') ? u.angles : {};
  }

  // Read a camera's view transform. Missing/invalid → neutral.
  function angleOf(cam) {
    const a = cam ? anglesFor(cam.source)[cam.id] : null;
    const rot = a && ROTATIONS.includes(a.rot) ? a.rot : 0;
    const flip = !!(a && a.flip);
    const z = a && Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(1, z)) : 1;
    const panX = zoom > 1 ? clampPan(a && a.panX) : 0;
    const panY = zoom > 1 ? clampPan(a && a.panY) : 0;
    return { rot, flip, zoom, panX, panY };
  }

  // Apply a rotation/flip/zoom/pan to a snapshot <img>. Quarter turns (90/270) swap
  // the image's aspect, so switch that card to `contain` to avoid a mis-crop. The
  // pan translate is the outermost op (screen-space), so panning stays intuitive
  // regardless of rotation; at panX/Y = ±100 the image edge just reaches the frame.
  function applyCamAngle(img, ang) {
    if (!img) return;
    const parts = [];
    const z = ang.zoom > 1 ? ang.zoom : 1;
    if (z > 1 && (ang.panX || ang.panY)) {
      const tx = (ang.panX * (z - 1)) / 2;         // % of the element box
      const ty = (ang.panY * (z - 1)) / 2;
      parts.push('translate(' + tx.toFixed(2) + '%, ' + ty.toFixed(2) + '%)');
    }
    if (ang.rot) parts.push('rotate(' + ang.rot + 'deg)');
    if (ang.flip) parts.push('scaleX(-1)');
    if (z > 1) parts.push('scale(' + z + ')');
    img.style.transform = parts.join(' ');
    img.classList.toggle('up-cam-img--rot', ang.rot === 90 || ang.rot === 270);
  }

  // Sort a camera list by the user's saved order; unranked/new cameras keep their
  // original relative order at the end (Array.prototype.sort is stable).
  function orderCameras(list, order) {
    if (!Array.isArray(order) || !order.length) return list;
    const rank = new Map(order.map((id, i) => [id, i]));
    return list.slice().sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });
  }

  // Push the layout choices onto a .up-grid as CSS variables + a mode class. Auto
  // (columns 0) keeps the default responsive auto-fit; a fixed count switches to
  // repeat(N). fit/aspect are variables consumed by .up-cam / .up-cam-img.
  function applyGridVars(grid, lay) {
    if (!grid) return;
    grid.style.setProperty('--up-fit', lay.fit);
    grid.style.setProperty('--up-aspect', ASPECT_CSS[lay.aspect] || '16 / 9');
    if (lay.columns > 0) {
      grid.style.setProperty('--up-cols', String(lay.columns));
      grid.classList.add('up-grid--fixed');
    } else {
      grid.style.removeProperty('--up-cols');
      grid.classList.remove('up-grid--fixed');
    }
  }

  // Re-apply layout to a live tile WITHOUT rebuilding the grid: variables update in
  // place, and cards are re-appended in the new order (no snapshot re-fade).
  function applyLayout(tile) {
    const grid = tile.mount && tile.mount.querySelector('.up-grid');
    if (!grid) return;
    const lay = layoutOf();
    applyGridVars(grid, lay);
    if (tile.cams && tile.cams.length) {
      // Reorder by the UniFi order list: UniFi cams get ranks, HA cams sort to the
      // end (Infinity) in their existing selection order — so the UniFi-first,
      // HA-after grouping is preserved without namespacing the order field.
      const ordered = orderCameras(tile.cams, lay.order);
      ordered.forEach((cam) => {
        if (cam.card) grid.appendChild(cam.card);
        applyCamAngle(cam.img, angleOf(cam));
      });
      tile.cams = ordered;
    }
    if (tile.expandCam) applyCamAngle(tile.expandCam.img, angleOf(tile.expandCam));
    retimePulling(tile);
  }

  // Double-buffer: preload the next frame into a detached Image and only swap the
  // visible <img> once it has decoded, so a refresh never flashes blank. A
  // per-camera in-flight guard keeps a slow console from stacking requests.
  function refreshOne(cam) {
    if (!cam || cam.loading || !cam.img) return;
    cam.loading = true;
    const pre = new Image();
    pre.onload = () => {
      cam.loading = false;
      if (cam.img) { cam.img.src = pre.src; cam.img.classList.add('is-live'); }
      if (cam.card) cam.card.classList.remove('up-cam--stale');
    };
    pre.onerror = () => {
      cam.loading = false;
      if (cam.card) cam.card.classList.add('up-cam--stale');
    };
    pre.src = snapUrl(cam);
  }

  function tick(tile) {
    if (!tile.pulling) return;
    tile.cams.forEach(refreshOne);
    if (tile.expandCam) refreshOne(tile.expandCam);
  }

  // Restart the snapshot timer if the user changed the refresh rate while it runs.
  function retimePulling(tile) {
    if (!tile.pulling) return;
    const ms = layoutOf().refreshMs;
    if (ms === tile.refreshMs) return;
    tile.refreshMs = ms;
    if (tile.timer) clearInterval(tile.timer);
    tile.timer = setInterval(() => tick(tile), ms);
  }

  // Persist a camera's rotation/flip/zoom/pan. A fully neutral view drops the entry
  // so the map stays lean (and "show all"-style defaults keep working for new
  // cameras). Pan is only stored while zoomed in.
  function setCamAngle(cam, next) {
    const id = cam.id;
    const cur = anglesFor(cam.source);
    const angles = {};
    for (const k of Object.keys(cur)) angles[k] = cur[k];   // shallow copy
    const rot = ROTATIONS.includes(next.rot) ? next.rot : 0;
    const flip = next.flip ? 1 : 0;
    const z = Number(next.zoom);
    const zoom = Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) {
      delete angles[id];
    } else {
      const entry = { rot, flip };
      if (zoom > 1) {
        entry.zoom = zoom;
        const panX = Math.round(clampPan(next.panX)), panY = Math.round(clampPan(next.panY));
        if (panX) entry.panX = panX;
        if (panY) entry.panY = panY;
      }
      angles[id] = entry;
    }
    // Persist to the store that owns this source: UniFi transforms in
    // settings.unifi.angles, HA transforms in settings.homeAssistant.camAngles.
    if (cam.source === 'ha') { if (window.setHomeAssistantSettings) window.setHomeAssistantSettings({ camAngles: angles }); }
    else if (window.setUnifiSettings) window.setUnifiSettings({ angles });
  }

  window.UnifiWidgetCameraLayout = {
    readHubSettings, ASPECT_CSS, ROTATIONS, DEFAULT_REFRESH_MS, layoutOf, MAX_ZOOM, angleOf,
    applyCamAngle, orderCameras, applyGridVars, applyLayout, refreshOne, tick, setCamAngle,
  };
})();
