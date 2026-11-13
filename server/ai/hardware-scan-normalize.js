// Checks a hardware scan result (memory, cores, which local AI model fits) when a browser sends
// it back with the settings.

const { clampNumber } = require('../settings/values.js');
const aiLocal = require('../ai-local.js');

// Hardware scan result is server-generated; when echoed back from the client we
// keep only the known numeric/string fields and drop anything unexpected.
function normalizeHardwareScan(value) {
  if (!value || typeof value !== 'object') return null;
  const tiers = ['incompatible', 'minimum', 'recommended', 'optimal'];
  const tier = tiers.includes(value.tier) ? value.tier : 'incompatible';
  return {
    ram: clampNumber(value.ram, 0, 4096, 0),
    vram: clampNumber(value.vram, 0, 4096, 0),
    cores: clampNumber(value.cores, 0, 512, 0),
    tier,
    recommended: aiLocal.sanitizeModel(value.recommended),
  };
}

module.exports = { normalizeHardwareScan };
