// Sends the football scores to every dashboard only when they changed, and keeps what is known
// of each followed team fresh.

const fs = require('node:fs');
const { broadcastSSE } = require('../http/sse-clients.js');
const football = require('../football.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { hub } = require('../settings/current.js');
const { _footballOpts } = require('./feed-settings.js');
const { footballState } = require('./football-state.js');
const { FOOTBALL_INFO_FILE, FOOTBALL_INFO_TTL_MS } = require('./football-caches.js');

// The identity map is part of the signature: it lands after the fixtures on a
// cold start, and without it in the dedup the crests would only reach an already
// connected dashboard on the next score change.
function _footballPayload() {
  return { teams: footballState.cache.teams, live: footballState.cache.live, refreshedAt: footballState.cache.refreshedAt, info: footballState.info };
}
function _pushFootball() {
  const sig = JSON.stringify(footballState.cache.teams) + '|' + footballState.cache.live + '|' + JSON.stringify(footballState.info);
  if (sig === footballState.sig) return;
  footballState.sig = sig;
  broadcastSSE('football', _footballPayload());
}

async function _loadFootballInfo() {
  if (footballState.infoLoaded) return;
  footballState.infoLoaded = true;
  try {
    const raw = JSON.parse(await fs.promises.readFile(FOOTBALL_INFO_FILE, 'utf8'));
    if (raw && typeof raw.info === 'object' && raw.info) footballState.info = raw.info;
    if (raw && typeof raw.at === 'object' && raw.at) footballState.infoAt = raw.at;
  } catch { /* first run, or an unreadable cache → refetch on the next warm */ }
}
// Fetch identity only for followed clubs that have none or whose copy is a day
// old. At rest this is zero requests; a newly added club costs exactly one.
async function _warmFootballInfo(favorites) {
  if (footballState.infoWarming) return;
  await _loadFootballInfo();
  const list = Array.isArray(favorites) ? favorites : [];
  const now = Date.now();
  let changed = false;

  // Prune first, and unconditionally: an identity is only kept for a club still
  // being followed. Doing it inside the fetch path meant unfollowing everything
  // left the file exactly as it was, forever, because there was then nothing
  // stale to go and fetch.
  const keep = new Set(list.filter(f => f && f.type !== 'league').map(f => football.cleanId(f.id)).filter(Boolean));
  for (const id of Object.keys(footballState.info)) {
    if (!keep.has(id)) { delete footballState.info[id]; delete footballState.infoAt[id]; changed = true; }
  }

  const stale = Array.from(keep).filter(id => !(footballState.info[id] && now - (footballState.infoAt[id] || 0) < FOOTBALL_INFO_TTL_MS));
  if (stale.length) {
    footballState.infoWarming = true;
    try {
      const fetched = await football.fetchTeamInfo(stale, {
        ..._footballOpts(),
        lang: (hub.settings && hub.settings.language) || 'en',
      });
      for (const [id, teamInfo] of Object.entries(fetched || {})) {
        footballState.info[id] = teamInfo;
        footballState.infoAt[id] = now;
        changed = true;
      }
    } catch { /* identity is a nicety; fixtures must not fail with it */ }
    finally { footballState.infoWarming = false; }
  }
  if (changed) {
    await writeFileAtomic(FOOTBALL_INFO_FILE, JSON.stringify({ info: footballState.info, at: footballState.infoAt })).catch(() => {});
  }
}

module.exports = { _footballPayload, _pushFootball, _loadFootballInfo, _warmFootballInfo };
