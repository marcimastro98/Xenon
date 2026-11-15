'use strict';
// Text from SoundVolumeView, the Windows tool behind every audio device switch.
//
// Issue #145: a Deck key that switches to "Kopfhörer" (the default name of
// headphones on a German Windows) did nothing, silently. The device list came
// from `SoundVolumeView /scomma`, saved in the tool's "default" encoding and
// read back here as latin1. Whenever those two disagreed, "ö" arrived as "Ã¶":
// the list showed a device that does not exist, the key stored that name, and
// /SetDefault was then handed a device SoundVolumeView could not find, which it
// does not report. Any name outside latin1 (Japanese, Korean, Polish, Czech...)
// was lost even when they agreed, because the ANSI code page cannot hold it.
//
// So the encoding is no longer left to a default: the export asks for UTF-8
// (`/SaveFileEncoding 3`, in SoundVolumeView's own readme), and decodeCsv reads
// what actually arrived, by its byte order mark when there is one.

/** The command-line switches that make the CSV export UTF-8, whatever the .cfg says. */
const UTF8_EXPORT = ['/SaveFileEncoding', '3'];

/**
 * Decode a SoundVolumeView CSV export. UTF-8 (with or without BOM) and UTF-16
 * (LE or BE, by BOM) are read as such; bytes that are not valid UTF-8 can only
 * be an ANSI export from an older tool or config, read as latin1, which is what
 * every Western code page agrees with for the characters that matter here.
 */
function decodeCsv(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return b.subarray(3).toString('utf8');
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = b.toString('utf8');
  return utf8.includes('�') ? b.toString('latin1') : utf8;
}

/**
 * A device id saved while the list was still being misread: UTF-8 bytes read
 * as latin1 ("KopfhÃ¶rer"). Returns the name it was meant to be, or null when
 * the text does not look like that at all. Used only to recognise a key saved
 * before the fix; the result is still matched against the live device list,
 * never used on its own.
 */
function repairMojibake(text) {
  const s = String(text == null ? '' : text);
  // A UTF-8 lead byte (Ã, Â, Ä, Å...) followed by a continuation byte, as latin1.
  if (!/[Â-ô][\u0080-¿]/.test(s)) return null;
  if (/[^\u0000-ÿ]/.test(s)) return null;          // real Unicode already: not mojibake
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  if (fixed.includes('�') || fixed === s) return null;
  return fixed;
}

module.exports = { UTF8_EXPORT, decodeCsv, repairMojibake };
