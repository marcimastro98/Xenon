'use strict';

// Shared pieces of the create_preset critique (ai-preset-critique.js): the
// finding shape, the WCAG contrast test and box geometry. A finding is
// computed, never taste: a ratio below a threshold, two boxes that intersect,
// a key that shows nothing. Colour maths is the app's own (js/theme-palette.js),
// so a ratio here is the ratio the app's contrast guard would compute.

const themePalette = require('./js/theme-palette.js');

// WCAG 2 minimums: body text, and large text or UI parts (icons, borders, state).
const BODY_TEXT = 4.5;
const LARGE_TEXT = 3;
// A ratio this close above its minimum is reported as "consider".
const NEAR_FACTOR = 1.1;

function finding(severity, where, problem, hint) {
  const out = { severity, where, problem };
  if (hint) out.hint = hint;
  return out;
}

// Two decimals, rounded down, so a failing 4.497 never reads as "4.5:1".
const ratioText = (r) => (Math.floor(r * 100) / 100) + ':1';

// The lowest contrast of `fg` against any of `backs` (a gradient's stops).
function worstContrast(fg, backs) {
  return Math.min(...backs.map((b) => themePalette.contrast(fg, b)));
}

// 'fix' below `min`, 'consider' just above it, '' when comfortably readable.
function contrastSeverity(ratio, min) {
  if (ratio < min) return 'fix';
  return ratio < min * NEAR_FACTOR ? 'consider' : '';
}

// One contrast finding, or null. `fgName` names the colour to change in the hint.
function contrastFinding(where, fg, backs, min, fgName) {
  const list = Array.isArray(backs) ? backs : [backs];
  const ratio = worstContrast(fg, list);
  const severity = contrastSeverity(ratio, min);
  if (!severity) return null;
  const worstBack = list.find((b) => themePalette.contrast(fg, b) === ratio);
  const better = themePalette.ensureContrast(fg, worstBack, min * NEAR_FACTOR);
  const reachable = themePalette.contrast(better, worstBack) >= min;
  const hint = reachable
    ? (fgName || 'the colour') + ' ' + better + ' reaches ' + ratioText(themePalette.contrast(better, worstBack))
    : 'no colour reaches ' + min + ':1 on ' + worstBack + ': make that colour lighter or darker';
  return finding(severity, where, 'contrast ' + ratioText(ratio) + ' (' + fg + ' on ' + worstBack + '), needs ' + min + ':1', hint);
}

// ── boxes {x, y, w, h} ────────────────────────────────────────────────────

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

const boxText = (b) => b.x + ',' + b.y + ' ' + b.w + 'x' + b.h;

module.exports = {
  BODY_TEXT, LARGE_TEXT, NEAR_FACTOR, finding, ratioText, worstContrast, contrastSeverity, contrastFinding,
  overlapArea, contains, boxText,
};
