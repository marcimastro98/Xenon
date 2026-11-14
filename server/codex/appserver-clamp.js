'use strict';
// Clamps a value Codex sent before it is kept: a trimmed string, a whole number, a percentage.

function str(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : ''; }
function int(v) { return Number.isFinite(v) ? Math.round(v) : null; }
function pct(v) { return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null; }

module.exports = { str, int, pct };
