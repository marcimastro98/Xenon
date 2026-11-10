'use strict';
// Shared by the brand tables. products are vendor and product id in one number, so a
// lookup is one Map get.

const productKey = (vendorId, productId) => vendorId * 0x10000 + productId;
const ids = (vendorId, productIds) => productIds.map((productId) => productKey(vendorId, productId));

// Gauges of a few steps, as a share of the top step.
const percentOfSteps = (step, steps) => Math.round((step / steps) * 100);

const validPercent = (value) => (value > 0 && value <= 100 ? value : null);

// No percent is no reading: a device that cannot say is left out, never shown as empty.
const reading = (percent, charging = null) => (percent === null ? [] : [{ percent, charging }]);

module.exports = { productKey, ids, percentOfSteps, validPercent, reading };
