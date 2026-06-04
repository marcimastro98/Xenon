'use strict';
// Typed-action catalog + validator for Performance Mode's system actions. The
// single source of truth for what the perf runner accepts, mirroring the Deck's
// deck-actions.js. No DOM, no execution here — validation happens at the server
// boundary (actions/perf-registry.js). Phase 2 covers guided, reversible app
// management; see docs/superpowers/specs/performance-mode.md.
//
// param.kind: 'id' (window handle, digits only) | 'path' (executable path) |
//             'proc' (process name) | 'select' (one of `options`).

const PERF_ACTION_CATALOG = [
  { type: 'closeApp',    params: [{ name: 'id',    kind: 'id'   }] },
  { type: 'launchApp',   params: [{ name: 'path',  kind: 'path' }] },
  { type: 'setPriority', params: [{ name: 'name',  kind: 'proc' }, { name: 'level', kind: 'select', options: ['high', 'normal'] }] },
];

function perfActionSpec(type) {
  return PERF_ACTION_CATALOG.find(a => a.type === type) || null;
}

// Return a clean action with ONLY the params its spec allows, or null if the
// type is unknown or a required value is malformed. 'id' must be 1–24 digits
// (a Win32 HWND); 'path' is a capped string (the registry re-checks extension
// and existence before launching).
function validatePerfAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const spec = perfActionSpec(raw.type);
  if (!spec) return null;
  const out = { type: spec.type };
  for (const p of spec.params) {
    const v = raw[p.name];
    if (p.kind === 'id') {
      const s = String(v == null ? '' : v).trim();
      if (!/^\d{1,24}$/.test(s)) return null;
      out[p.name] = s;
    } else if (p.kind === 'proc') {
      // Process base name (no path, no extension): a conservative charset.
      const s = String(v == null ? '' : v).trim().replace(/\.exe$/i, '');
      if (!/^[\w.+\- ]{1,60}$/.test(s)) return null;
      out[p.name] = s;
    } else if (p.kind === 'select') {
      out[p.name] = (typeof v === 'string' && p.options.includes(v)) ? v : p.options[0];
    } else {
      out[p.name] = String(v == null ? '' : v).slice(0, 1024);
    }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.PerfActions = { PERF_ACTION_CATALOG, perfActionSpec, validatePerfAction };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PERF_ACTION_CATALOG, perfActionSpec, validatePerfAction };
}
