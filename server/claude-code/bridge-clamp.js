'use strict';
// Clamps what Claude Code sends before it is kept or drawn: a trimmed string, a finite number,
// a percentage, the project's folder name.

const path = require('node:path');
const { MAX_STR } = require('./bridge-limits.js');

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  const cap = max || MAX_STR;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 0-100, or null when the field is absent. Each rate-limit window is
// independently optional (and absent entirely for API-key users), so an absent
// window must render as "unknown", never as 0%.
function pct(v) {
  const n = num(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

function projectName(cwd) {
  const c = str(cwd, 400);
  if (!c) return '';
  return str(path.basename(c.replace(/[\\/]+$/, '')) || c, 60);
}

module.exports = { str, num, pct, projectName };
