'use strict';
// The person's own Bit in a settings backup: the whole of bit.json, so the same
// Bit (seed, number, name, wardrobe, days, what it learnt) comes back on a new
// PC. An egg travels as nothing: the new PC hatches its own. A restore goes
// through model.js's normalizer like any read of the file.

const Model = require('./model.js');

/** @param {{ store: any }} opts */
function createBitBackup({ store }) {
  async function save() {
    const model = await store.ready();
    return model.bit ? { ...model } : null;
  }

  async function restore(section) {
    const model = Model.normalize(section);
    if (!model.bit) throw new Error('bit_shape');
    await store.replace(model);
  }

  return { save, restore };
}

module.exports = { createBitBackup };
