'use strict';
// The text the Claude Code runner takes in and shows: control characters stripped and a length
// kept, the short id of a project folder, and the one line that says what a tool call touches.

const crypto = require('node:crypto');

const MAX_DETAIL = 120;

// Control characters are stripped rather than escaped. Nothing here is a shell
// argument (there is no shell), but a stray escape sequence out of a transcript
// or a stderr line would corrupt the tile layout. Tab and newline survive: a
// dictated prompt legitimately contains them.
function str(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const n = ch.charCodeAt(0);
    if ((n < 32 && n !== 9 && n !== 10) || (n >= 127 && n < 160)) continue;
    out += ch;
  }
  const s = out.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function projectId(dir) {
  return crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);
}

// One line saying what a tool call touches: the command, the file, the
// pattern, the address. Never the content of a file or an edit.
function toolDetail(input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.command || i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.query || i.description || '';
  return str(String(v).split('\n')[0], MAX_DETAIL);
}

module.exports = { MAX_DETAIL, str, projectId, toolDetail };
