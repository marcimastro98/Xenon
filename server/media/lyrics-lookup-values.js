// How the lyrics lookup names itself to the lyrics service, and the lookups under way.

const { APP_VERSION } = require('../updates/app-version.js');

// ── Song lyrics (LRCLIB) ─────────────────────────────────────────────────────
// Lyrics for whatever is playing, from any host (lyrics.js builds the query,
// lyrics-cache.js remembers the answer). One lookup per track at a time, and a
// 429/503 from LRCLIB pauses EVERY lookup until its Retry-After has passed —
// their API terms require it.
const LYRICS_USER_AGENT = `Xenon v${APP_VERSION || '0'} (https://github.com/marcimastro98/Xenon)`;
const _lyricsPending = new Map();

module.exports = { LYRICS_USER_AGENT, _lyricsPending };
