'use strict';

// The Store review's mechanical half, run on a widget or Ambient package the
// assistant made, so what it builds could be published as it is. Mirrors the
// checklist the human review follows (permissions against use, hidden or
// dynamic code, loops that run while hidden); taste stays with the review.

const { SDK_ACTION_CATEGORIES } = require('./sdk-widgets.js');
const { finding } = require('./ai-preset-critique-core.js');

const quoted = (word) => new RegExp('[\'"`]' + word + '[\'"`]');

// Opt-in manifest grants → what in the code shows the widget uses them.
const GRANTS = [
  ['storage', (m) => m.storage === true || !!m.storageGroup, /['"`]store['"`]/],
  ['secrets', (m) => m.secrets === true, /['"`]secret['"`]|\{\{secret:/],
  ['clipboard', (m) => m.clipboard === true, quoted('clipboard')],
  ['island', (m) => !!m.island, quoted('island')],
  ['badge', (m) => !!m.badge, quoted('badge')],
  ['mini', (m) => m.mini === true, quoted('mini')],
];

const HIDDEN_CODE = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer given a string of code'],
  [/\bdocument\.write\s*\(/, 'document.write()'],
  [/<script[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i, 'a <script> loaded from another site'],
];
// A run this long of base64 is data or code nobody can read in review.
const BLOB = /[A-Za-z0-9+/]{2000,}={0,2}/;
const LOOP = /\brequestAnimationFrame\s*\(|\bsetInterval\s*\(/;
const PAUSES = /['"`]visibility['"`]|visibilitychange|document\.hidden/;

function manifestOf(entry) {
  const files = entry.payload && Array.isArray(entry.payload.files) ? entry.payload.files : [];
  const file = files.find((f) => f.path === 'manifest.json');
  try { return file ? JSON.parse(Buffer.from(String(file.data || ''), 'base64').toString('utf8')) : {}; } catch { return {}; }
}

function unusedGrants(entry, manifest, text) {
  const out = [];
  for (const category of entry.actions || []) {
    const types = SDK_ACTION_CATEGORIES[category] || [];
    if (!types.some((type) => quoted(type).test(text))) {
      out.push(finding('fix', 'manifest.actions', 'asks for the "' + category + '" actions but no file sends one', 'remove it: the Store review asks for every permission to be used'));
    }
  }
  for (const [key, asked, used] of GRANTS) {
    if (asked(manifest) && !used.test(text)) {
      out.push(finding('fix', 'manifest.' + key, 'asks for ' + key + ' but no file uses it', 'remove it: the Store review asks for every permission to be used'));
    }
  }
  return out;
}

function critiqueStoreRules(entry, text) {
  const out = unusedGrants(entry, manifestOf(entry), text);
  for (const [pattern, what] of HIDDEN_CODE) {
    if (pattern.test(text)) out.push(finding('fix', 'files', 'uses ' + what + ', which the Store review refuses as hidden or dynamic code', 'write the code out plainly in the package files'));
  }
  if (BLOB.test(text)) out.push(finding('consider', 'files', 'carries a long base64 blob that a reviewer cannot read', 'ship it as its own file in the package'));
  if (LOOP.test(text) && !PAUSES.test(text)) {
    out.push(finding('fix', 'files', 'animates or polls with no pause while the tile is hidden', 'stop the loop on the bridge "visibility" message (hidden: true) and start it again when shown'));
  }
  return out;
}

module.exports = { critiqueStoreRules };
