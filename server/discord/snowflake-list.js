// Checks a saved list of Discord ids: digits only, no repeats, no longer than its limit.

// A bounded, deduped list of Discord snowflake ids. Shared by the server store
// and mirrored in js/settings.js — see discordFavChannels.
function normalizeSnowflakeList(value, max = 50) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const id = String(raw == null ? '' : raw).trim();
    if (!/^\d{5,25}$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}


module.exports = { normalizeSnowflakeList };
