'use strict';
// What the program in front says the user is doing: coding, writing or something else.

// Foreground-process classification for Performance Mode. Deterministic and
// cheap (no extra probing — reuses the foreground window the game detector
// already tracks). Used to label suggestions and, later, to seed the AI's
// activity-based optimization plan. 'gaming' wins via the full-screen detector.
const CODING_RE = /^(code|code-insiders|cursor|devenv|idea64|pycharm64|webstorm64|rider64|clion64|goland64|rubymine64|phpstorm64|datagrip64|rustrover64|studio64|sublime_text|atom|nvim|vim)$/i;
const WRITING_RE = /^(winword|notepad|notepad\+\+|obsidian|onenote|wps|wpsoffice|soffice|swriter|typora|scrivener|joplin)$/i;

function classifyActivity(name) {
  const n = String(name || '').toLowerCase().replace(/\.exe$/, '');
  if (!n) return 'other';
  if (CODING_RE.test(n)) return 'coding';
  if (WRITING_RE.test(n)) return 'writing';
  return 'other';
}

module.exports = { CODING_RE, WRITING_RE, classifyActivity };
