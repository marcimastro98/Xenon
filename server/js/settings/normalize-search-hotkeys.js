// Cleans the saved fan names and the search, page-hotkey and disk settings.
'use strict';

// User fan names: a flat { "<kind>|<sensor name>": "label" } map. Explicit
// rebuild (no spread of untrusted input), bounded on both axes: keys follow the
// collector's shape (kind ≤8 + '|' + name ≤48), labels are what fits a row.
function normalizeFanLabels(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 64) break;
    if (typeof key !== 'string' || key.length > 60 || !key.includes('|')) continue;
    const label = typeof v[key] === 'string' ? v[key].trim().slice(0, 32) : '';
    if (!label) continue;
    out[key] = label;
    n++;
  }
  return out;
}

// Local search (Spotlight) — mirrors the server's normalizeSearchSettings so
// both sides rebuild the same shape (settings invariant).
function normalizeSearchSettings(value, defaultRoot) {
  const v = value && typeof value === 'object' ? value : {};
  // indexRoots: the Living Index roots (drives or folders). Migration: older
  // saves carried extraFolders (the retired one-shot crawl) — adopt them.
  // Never-set → the server supplies the default for the machine it is running
  // on (`defaultRoot`); an explicitly emptied list means the user turned the
  // index off and stays empty.
  const rawRoots = Array.isArray(v.indexRoots) ? v.indexRoots
    : (Array.isArray(v.extraFolders) && v.extraFolders.length ? v.extraFolders : null);
  // Both root shapes are accepted here whatever the machine is, exactly as the
  // server does. This copy runs in the BROWSER and cannot know what the host
  // is: a validator that guessed would drop the user's root on the next save.
  // The backslash rewrite therefore applies to the Windows shape ONLY — off
  // Windows a backslash is a legal filename character, and rewriting "/" there
  // turned "/Users/me" into "\Users\me", which no drive-letter test accepts.
  const cleanRoot = (raw) => {
    const s = String(raw || '').trim().slice(0, 4096);
    // One leading slash is POSIX; two is a UNC share and stays rejected.
    if (/^\/(?!\/)/.test(s)) return s.length > 1 ? s.replace(/\/+$/, '') : s;
    const w = s.slice(0, 260).replace(/\//g, '\\');
    if (!/^[A-Za-z]:\\?$|^[A-Za-z]:\\.+/.test(w)) return '';
    return w.length === 2 ? w + '\\' : w;
  };
  // A caller that knows the machine passes `defaultRoot` and gets it back. A
  // caller that does not gets NO indexRoots at all — never-set stays never-set.
  // The old fallback invented "C:\" for that second case, and since this copy
  // runs in the browser, which has no way to know that is wrong, a Mac or a
  // Linux box saved a Windows drive letter as its search root the first time
  // the dashboard wrote anything. The index could then never start, and
  // Settings showed a configured folder the whole time, so there was nothing
  // the user could do about it.
  const roots = rawRoots == null
    ? (defaultRoot ? [defaultRoot] : null)
    : rawRoots.map(cleanRoot).filter(Boolean).slice(0, 8);
  const combo = String(v.hotkeyCombo || 'alt+space').toLowerCase().trim().slice(0, 40);
  return {
    ...(roots ? { indexRoots: roots } : {}),
    hotkeyEnabled: v.hotkeyEnabled === true,
    hotkeyCombo: /^[a-z0-9+ ]{3,40}$/.test(combo) ? combo : 'alt+space',
    // AI full context for explicit Search + Disk Advisor calls —
    // privacy-touching, strict opt-in like the wake word.
    aiFullContext: v.aiFullContext === true,
    // Recent files in the Search tile's empty state: off unless chosen.
    recentInTile: v.recentInTile === true,
  };
}

// Disk widget knobs — mirrors the server's normalizeDiskSettings.
// Global shortcuts that flip the dashboard to a page while another app has
// focus — the whole point of a second screen you are not clicking on. Each
// entry is a combo and what it goes to: a page id, or one of the relative
// moves, which are what "toggle between my two pages" is actually asking for.
//
// The page id is NOT validated against the current pages here. Pages live in
// the dashboard layout, which is per device, and this list is shared by all of
// them: dropping an id the saving device happens not to have would delete
// another screen's shortcut every time the user saved anything. The client
// resolves the id when the shortcut fires and does nothing if it is not there.
function normalizePageHotkeys(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const combo = String(raw.combo || '').toLowerCase().trim().slice(0, 40);
    // The same shape the Spotlight combo is held to, and the same reason: the
    // helpers parse it themselves and report a combo they cannot read, so this
    // only has to keep the argument list free of anything shell-shaped.
    if (!/^[a-z0-9+ ]{3,40}$/.test(combo)) continue;
    if (seen.has(combo)) continue;            // two actions on one combo: the desktop fires neither
    const target = String(raw.target || '').trim().slice(0, 64);
    if (!target) continue;
    seen.add(combo);
    out.push({ combo, target });
    if (out.length >= MAX_PAGE_HOTKEYS) break;
  }
  return out;
}

function normalizeDiskSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const folders = Array.isArray(v.devFolders)
    ? v.devFolders.map((f) => String(f || '').trim().slice(0, 260)).filter((f) => /^[A-Za-z]:[\\/]/.test(f)).slice(0, 10)
    : [];
  const age = Number(v.installerAgeDays);
  return {
    devFolders: folders,
    installerAgeDays: Number.isFinite(age) ? Math.max(7, Math.min(365, Math.round(age))) : 30,
  };
}
