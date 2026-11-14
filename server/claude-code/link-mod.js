'use strict';
// The mod put in and taken out of Claude Code's settings by entries alone: our marketplace, the
// plugin switched on and its default options, adding only what is absent and removing only what
// is still ours.

// The Xenon mod for Claude Code (integrations/claude-code/). Installing it is a
// settings entry, not a spawned `claude`: Claude Code reads extraKnownMarketplaces
// and enabledPlugins in the user's settings, clones the marketplace on its next
// start and enables the plugin. The marketplace name must equal the one in the
// repo's .claude-plugin/marketplace.json.
const MOD_MARKETPLACE = 'xenon';
const MOD_REPO = 'marcimastro98/Xenon';
const MOD_PLUGIN_ID = 'xenon@xenon';
// The mod's own manifest defaults, written once so the first run does not depend
// on how Claude Code treats an option with no stored value.
const MOD_DEFAULT_OPTIONS = { band: true, approvals: false, approvalWaitSec: 30 };

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Adds the mod to a settings object. Anything the user already decided stays:
// a "xenon" marketplace of another source, a plugin they switched off, options
// they set. Returns the same object it was given.
function addMod(settings) {
  const markets = isPlainObject(settings.extraKnownMarketplaces) ? { ...settings.extraKnownMarketplaces } : {};
  if (markets[MOD_MARKETPLACE] && !(markets[MOD_MARKETPLACE].source && markets[MOD_MARKETPLACE].source.repo === MOD_REPO)) {
    return settings;                                // the name is theirs: not ours to reuse
  }
  markets[MOD_MARKETPLACE] = { source: { source: 'github', repo: MOD_REPO } };
  settings.extraKnownMarketplaces = markets;

  const enabled = isPlainObject(settings.enabledPlugins) ? { ...settings.enabledPlugins } : {};
  if (enabled[MOD_PLUGIN_ID] === undefined) enabled[MOD_PLUGIN_ID] = true;
  settings.enabledPlugins = enabled;

  const configs = isPlainObject(settings.pluginConfigs) ? { ...settings.pluginConfigs } : {};
  if (!configs[MOD_PLUGIN_ID]) configs[MOD_PLUGIN_ID] = { options: { ...MOD_DEFAULT_OPTIONS } };
  settings.pluginConfigs = configs;
  return settings;
}

// Removes what addMod added, and only the marketplace if it is still ours.
function removeMod(settings) {
  for (const key of ['enabledPlugins', 'pluginConfigs']) {
    if (!isPlainObject(settings[key])) continue;
    const next = { ...settings[key] };
    delete next[MOD_PLUGIN_ID];
    if (Object.keys(next).length) settings[key] = next; else delete settings[key];
  }
  if (isPlainObject(settings.extraKnownMarketplaces)) {
    const next = { ...settings.extraKnownMarketplaces };
    const m = next[MOD_MARKETPLACE];
    if (m && m.source && m.source.repo === MOD_REPO) delete next[MOD_MARKETPLACE];
    if (Object.keys(next).length) settings.extraKnownMarketplaces = next; else delete settings.extraKnownMarketplaces;
  }
  return settings;
}

module.exports = {
  MOD_MARKETPLACE, MOD_REPO, MOD_PLUGIN_ID, MOD_DEFAULT_OPTIONS, isPlainObject, addMod, removeMod,
};
