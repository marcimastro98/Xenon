// The pairing tokens of light bridges inside the settings: blanked before settings go to a
// browser, and found when a backup needs to know.

// Hue/Nanoleaf pairing tokens live inside lighting.providers[].devices[].token.
// They are bridge-owned server-only secrets: blank them on the wire (a
// `tokenSet` flag keeps "paired" visible). No preserve half is needed — the
// server refills lighting.providers from the live bridge on every settings
// write (POST /settings and backup import), so a token-less round-trip can
// never wipe a pairing.
function redactLightingTokens(settings) {
  const providers = settings && settings.lighting && settings.lighting.providers;
  if (!providers || typeof providers !== 'object') return settings;
  let changed = false;
  const safe = {};
  for (const [id, p] of Object.entries(providers)) {
    if (!p || !Array.isArray(p.devices)) { safe[id] = p; continue; }
    safe[id] = {
      ...p,
      devices: p.devices.map((d) => {
        if (!d || !d.token) return d;
        changed = true;
        const { token, ...rest } = d;
        return { ...rest, tokenSet: true };
      }),
    };
  }
  return changed ? { ...settings, lighting: { ...settings.lighting, providers: safe } } : settings;
}

function hasLightingProviderTokens(settings) {
  const providers = settings && settings.lighting && settings.lighting.providers;
  if (!providers || typeof providers !== 'object') return false;
  return Object.values(providers).some((p) => p && Array.isArray(p.devices) && p.devices.some((d) => d && d.token));
}

module.exports = { redactLightingTokens, hasLightingProviderTokens };
