'use strict';
// Windows reserved device names. A file or folder called one of these cannot
// be created (or opens the device instead): CON, PRN, AUX, NUL, CONIN$,
// CONOUT$, COM0-9 and LPT0-9, including the superscript-digit forms COM¹²³ /
// LPT¹²³ that Windows also treats as devices. Windows decides on the part
// before the first dot with trailing spaces ignored, so "con.txt",
// "con .txt" and "CON.tar.gz" are all the console device.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;

function isWindowsReservedName(name) {
  return WIN_RESERVED_RE.test(String(name == null ? '' : name));
}

module.exports = { WIN_RESERVED_RE, isWindowsReservedName };
