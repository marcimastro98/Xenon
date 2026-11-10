'use strict';
// Every device Xenon knows how to ask, by vendor and product id. Nothing outside this
// table is ever sent a byte, and each frame in it is a read.

const MODELS = [
  ...require('./rongyuan'),
  ...require('./logitech-headsets'),
  ...require('./logitech-centurion'),
  ...require('./compx'),
  ...require('./compx-variants'),
  ...require('./steelseries'),
  ...require('./hyperx'),
  ...require('./corsair'),
  ...require('./mice'),
  ...require('./razer-headsets'),
  ...require('./asus'),
  ...require('./keychron'),
  ...require('./alienware'),
  ...require('./ninjutso'),
  ...require('./endgame-gear'),
  ...require('./cherry'),
  ...require('./redragon'),
  ...require('./mchose'),
  ...require('./akko'),
  ...require('./playstation'),
  ...require('./sony-headsets'),
  ...require('./jbl'),
  ...require('./attack-shark'),
  ...require('./gamepads'),
];

const byProduct = new Map(MODELS.flatMap((model) => model.products.map((key) => [key, model])));
const vendorIds = [...new Set([...byProduct.keys()].map((key) => Math.floor(key / 0x10000)))];

module.exports = { MODELS, byProduct, vendorIds };
