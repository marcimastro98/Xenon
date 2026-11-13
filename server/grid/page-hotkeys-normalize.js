// Checks the saved keyboard shortcuts that switch the dashboard to a page.

// Disk widget knobs: dev folders (the ONLY places build-output dirs become
// cleanable) and how old a Downloads installer must be before it classifies.
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
const MAX_PAGE_HOTKEYS = 8;

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

module.exports = { MAX_PAGE_HOTKEYS, normalizePageHotkeys };
