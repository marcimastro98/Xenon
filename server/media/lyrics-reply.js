// Shapes found lyrics for the dashboard, and lists their lines for translation.

function lyricsReply(media, key, result) {
  const out = { ok: true, state: result.state, key, title: String(media.title || ''), source: 'LRCLIB' };
  if (result.state === 'synced') out.lines = result.lines;
  else if (result.state === 'plain') out.plain = result.plain;
  return out;
}

// The texts a translation is made from: always the server's own copy.
function lyricsTexts(entry) {
  if (!entry) return null;
  if (entry.state === 'synced') return entry.lines.map(l => l.text);
  if (entry.state === 'plain') return entry.plain;
  return null;
}

module.exports = { lyricsReply, lyricsTexts };
