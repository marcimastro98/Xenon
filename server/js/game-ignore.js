// Apps the user says are NOT games (Settings → Performance → Game mode, the
// "Not a game" list, the gameIgnore Deck action and Bit). Game detection reads
// the window in front: anything full-screen, or windowed and presenting frames
// at game rates, looks like a game, and a chat app or an AI desktop client on a
// big monitor does exactly that. The built-in list in gamedetect.js covers the
// known ones; this list is the user's own word for everything else.
//
//   gameIgnore: ['claude', 'someapp']   bare process names, lowercase, no .exe
//
// Pure, shared by the browser (normalizeSettings, the Settings list) and the
// server (normalizeHubSettings, gamedetect), so one rule reads the list.

(function (root) {
  const GAME_IGNORE_MAX = 40;
  // A process name as the probes report it: letters, digits and the few marks
  // real executables carry (spaces, dots, dashes, plus, brackets). Never a path.
  const NAME_RE = /^[\w .+\-()]{1,60}$/;

  // 'Claude.exe', ' CLAUDE ' → 'claude'; anything that is not a bare process
  // name → ''.
  function normalizeGameIgnoreName(value) {
    if (typeof value !== 'string') return '';
    const name = value.trim().toLowerCase().replace(/\.exe$/, '').trim();
    if (!name || name === '.' || name === '..' || !NAME_RE.test(name)) return '';
    return name;
  }

  function normalizeGameIgnore(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      const name = normalizeGameIgnoreName(item);
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= GAME_IGNORE_MAX) break;
    }
    return out;
  }

  const api = { GAME_IGNORE_MAX, normalizeGameIgnoreName, normalizeGameIgnore };
  if (root) root.GameIgnore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
