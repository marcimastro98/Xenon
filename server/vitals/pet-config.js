// The Vitals pet's settings, or nothing when the pet or Vitals is switched off.

const { hub } = require('../settings/current.js');

function vitalsPetCfg() {
  const v = hub.settings && hub.settings.vitals;
  return (v && v.enabled !== false && v.pet && v.pet.enabled === true) ? v.pet : null;
}

module.exports = { vitalsPetCfg };
