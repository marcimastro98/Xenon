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
const MAX_SCREEN_NAME = 48;
const MAX_SCREEN_SIDE = 16384;
const MAX_SCREEN_PLACE = 8 * MAX_SCREEN_SIDE;

// The monitor's model name, size and place on the desktop, so the menu can say which
// screen is which and draw them as they stand. None is needed: a shell that sends none
// falls back to a number, and screens with no place go in a row. A place can be negative.
function screenFacts(m) {
  const name = typeof m.name === 'string' ? m.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_SCREEN_NAME) : '';
  const side = (v) => Number.isInteger(v) && v > 0 && v <= MAX_SCREEN_SIDE;
  const place = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_SCREEN_PLACE;
  return {
    ...(name ? { name } : {}),
    ...(side(m.width) && side(m.height) ? { width: m.width, height: m.height } : {}),
    ...(place(m.x) && place(m.y) ? { x: m.x, y: m.y } : {}),
  };
}

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
      monitors.push({ key, primary: m.primary === true, ...screenFacts(m) });
    }
    // `scene`: it can draw the animated wallpaper and the screensaver.
    // `draw`: it can open the drawing sheet (screen-draw-shell.js).
    // `menu`: it can open the Xenon menu over the screen (screen-menu.js).
    // `anchor`: a widget can follow another app's window (capabilities/layer-anchor.js).
    // `desks`: it says which virtual desktop is shown, so a page can be tied to one.
    // `pad`: holding View + Menu on a controller opens the Xenon menu (layers/pad.rs).
    // `hide`: it can keep widget windows out of screenshots and recordings, so showing
    // them there is a real choice (capabilities/layer-captures.js).
    const layers = src.layers === true;
    report = {
      layers, scene: layers && src.scene === true, draw: layers && src.draw === true, menu: layers && src.menu === true, anchor: layers && src.anchor === true, desks: layers && src.desks === true, pad: layers && src.menu === true && src.pad === true, hide: layers && src.hide === true, monitors, at: now(),
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

  function hides() {
    const r = fresh();
    return !!(r && r.hide);
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

  return { accept, available, scenes, draws, menus, anchors, desks, pads, hides, setDesk, shownDesk, secondMonitor, monitors };
}

module.exports = { createLayersHost, REPORT_TTL_MS };
