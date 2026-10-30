'use strict';
// What the native shell says it can draw: whether it hosts widget layers at all
// (the browser-only build, GNOME on Wayland and an old shell do not) and which
// monitors it sees. The capability probe `layers` reads available(), so the AI
// and the Deck are never offered a placement nothing will draw.
//
// The report expires: a shell that quit without saying so stops counting after
// REPORT_TTL_MS, and a running shell re-reports well inside that window.
const REPORT_TTL_MS = 10 * 60 * 1000;
const MAX_MONITORS = 8;
const KEY_RE = /^[\x20-\x7e]{1,64}$/;

function createLayersHost({ now = Date.now } = {}) {
  let report = null;
  // The virtual desktop the shell last said is shown ({ current, count }).
  let desk = null;

  // Validated at the boundary: the body comes from the loopback shell, but it is
  // still wire data.
  function accept(body) {
    const src = body && typeof body === 'object' ? body : {};
    const monitors = [];
    for (const m of Array.isArray(src.monitors) ? src.monitors : []) {
      if (monitors.length >= MAX_MONITORS) break;
      const key = String(m && m.key || '');
      if (!KEY_RE.test(key) || monitors.some(x => x.key === key)) continue;
      monitors.push({ key, primary: m.primary === true });
    }
    // `scene`: it can draw the animated wallpaper and the screensaver.
    // `draw`: it can open the drawing sheet (screen-draw-shell.js).
    // `menu`: it can open the Xenon menu over the screen (screen-menu.js).
    // `anchor`: a widget can follow another app's window (capabilities/layer-anchor.js).
    // `desks`: it says which virtual desktop is shown, so a page can be tied to one.
    // `pad`: holding View + Menu on a controller opens the Xenon menu (layers/pad.rs).
    const layers = src.layers === true;
    report = {
      layers, scene: layers && src.scene === true, draw: layers && src.draw === true, menu: layers && src.menu === true, anchor: layers && src.anchor === true, desks: layers && src.desks === true, pad: layers && src.menu === true && src.pad === true, monitors, at: now(),
    };
    return { ok: true, layers: report.layers, monitors: monitors.length };
  }

  function fresh() {
    return report && now() - report.at < REPORT_TTL_MS ? report : null;
  }

  function available() {
    const r = fresh();
    return !!(r && r.layers);
  }

  function scenes() {
    const r = fresh();
    return !!(r && r.scene);
  }

  function draws() {
    const r = fresh();
    return !!(r && r.draw);
  }

  function menus() {
    const r = fresh();
    return !!(r && r.menu);
  }

  function anchors() {
    const r = fresh();
    return !!(r && r.anchor);
  }

  function desks() {
    const r = fresh();
    return !!(r && r.desks);
  }

  function pads() {
    const r = fresh();
    return !!(r && r.pad);
  }

  // The first screen that is not the main one, or '' when there is none.
  function secondMonitor() {
    const r = fresh();
    const m = r ? r.monitors.find(x => !x.primary) : null;
    return m ? m.key : '';
  }

  function monitors() {
    const r = fresh();
    return r ? r.monitors.slice() : [];
  }

  // POST /layers/desk, already validated: integers 0..64 (0 = a desktop with no
  // number, such as a full-screen Space on the Mac).
  function setDesk(current, count) {
    desk = { current, count };
  }

  function shownDesk() {
    return desks() && desk ? { ...desk } : null;
  }

  return { accept, available, scenes, draws, menus, anchors, desks, pads, setDesk, shownDesk, secondMonitor, monitors };
}

module.exports = { createLayersHost, REPORT_TTL_MS };
