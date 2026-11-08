'use strict';
// Which actions open a window on the screen, and whether the game in front lets
// them. A game in exclusive full screen owns the display (exclusive-hint.js).
// Measured on a real "Hardware: Legacy Flip" program: a window opening over it
// took the game out of exclusive and left no window in front, so the keyboard
// reached nothing, even after the window closed, and the menu was not seen at all.
// These actions say so instead. Whole-screen captures, recording and frame
// readings open no window and go on working.

// For Bit, who gets the code and has to explain it (the Deck words it in deck-error-text.js).
const OVER_EXCLUSIVE_HINT = 'The game in front is in exclusive full screen, so no window can open over it. Tell the user, and that picking borderless or windowed in the display settings of the game fixes it.';

const ALWAYS = new Set(['screenPin', 'screenCover', 'screenColor', 'screenMeasure', 'xenonScreen']);

function overExclusive(fps) {
  try {
    const stats = fps && typeof fps.getFrameStats === 'function' ? fps.getFrameStats() : null;
    return !!stats && stats.exclusive === true && !!stats.process;
  } catch { return false; }
}

function menuIsOpen(menu) {
  try { return !!menu && typeof menu.get === 'function' && menu.get().open === true; } catch { return false; }
}

function opensWindow(action, menu) {
  if (ALWAYS.has(action.type)) return true;
  switch (action.type) {
    case 'screenshot': return action.target === 'region' && action.mode !== 'reveal';
    case 'screenText': return !['window', 'screen'].includes(action.target);
    case 'screenDraw': return action.mode !== 'stop';
    case 'layersEdit': return action.mode !== 'off';
    case 'xenonMenu': return action.mode !== 'close' && !menuIsOpen(menu);
    default: return false;
  }
}

// Reads the frames only for an action that needs the answer.
function refusedOverGame(d, action) {
  return opensWindow(action, d && d.menu) && overExclusive(d && d.fps);
}

module.exports = { overExclusive, opensWindow, refusedOverGame, OVER_EXCLUSIVE_HINT };
