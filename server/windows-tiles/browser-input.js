'use strict';
// Turns a touch, click, wheel or key from the browser tile into the command the browser's
// debugging protocol takes.

// Translate a normalized client input event into a CDP Input.* command.
// Coordinates are page CSS pixels (the client maps canvas → page coords).
// Returns { method, params } or null if the event is unusable.
function inputToCdp(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const mods = num(evt.modifiers, 0) | 0;
  if (evt.kind === 'mouse') {
    const type = { pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved' }[evt.subtype];
    if (!type) return null;
    return { method: 'Input.dispatchMouseEvent', params: {
      type, x: num(evt.x, 0), y: num(evt.y, 0),
      button: ['left', 'right', 'middle', 'none'].includes(evt.button) ? evt.button : 'left',
      buttons: num(evt.buttons, 0) | 0,
      clickCount: num(evt.clickCount, 0) | 0,
      modifiers: mods,
    } };
  }
  if (evt.kind === 'wheel') {
    return { method: 'Input.dispatchMouseEvent', params: {
      type: 'mouseWheel', x: num(evt.x, 0), y: num(evt.y, 0),
      deltaX: num(evt.deltaX, 0), deltaY: num(evt.deltaY, 0),
      button: 'none', modifiers: mods,
    } };
  }
  if (evt.kind === 'touch') {
    // Real touch input goes through Chromium's gesture recognizer, so a drag
    // scrolls the page natively (with fling inertia) and a tap synthesizes a
    // click — instead of a touch-drag acting like a mouse text-selection.
    const type = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' }[evt.subtype];
    if (!type) return null;
    // Per the CDP contract, end/cancel send an empty touchPoints list (the
    // protocol diffs against the active points to find the lifted one).
    const touchPoints = (type === 'touchStart' || type === 'touchMove')
      ? [{ x: num(evt.x, 0), y: num(evt.y, 0) }]
      : [];
    return { method: 'Input.dispatchTouchEvent', params: { type, touchPoints, modifiers: mods } };
  }
  if (evt.kind === 'key') {
    const type = { down: 'keyDown', up: 'keyUp', char: 'char' }[evt.subtype];
    if (!type) return null;
    const params = { type, modifiers: mods };
    if (typeof evt.key === 'string') params.key = evt.key;
    if (typeof evt.code === 'string') params.code = evt.code;
    if (typeof evt.text === 'string') params.text = evt.text;
    if (Number.isFinite(evt.keyCode)) { params.windowsVirtualKeyCode = evt.keyCode | 0; params.nativeVirtualKeyCode = evt.keyCode | 0; }
    return { method: 'Input.dispatchKeyEvent', params };
  }
  return null;
}

module.exports = { inputToCdp };
