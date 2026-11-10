'use strict';
// ASUS ROG mice and keyboards. Channels and offsets as in peripheral-battery-tray (MIT)
// and HaloBattery (MIT). A sleeping device says FF AA, or a level of 0.
// Left out: keyboards on interface 1 and on the OMNI receiver. Their channel is a
// collection this table cannot pick, and the OMNI list of paired devices is another step.

const { ids, reading, validPercent } = require('./ids');

const ASUS = 0x0B05;
const CHANNEL_BYTES = 65;
const COMMAND = 0x12;
const MOUSE = 0x07;
const KEYBOARD = 0x01;
const REPLY_BYTES = 11;
const WAIT_MS = 500;
const GAUGE_STEP_PERCENT = 25;

function ask(io, sub) {
  const isAnswer = (r) => r.length >= REPLY_BYTES && ((r[0] === COMMAND && r[1] === sub) || (r[0] === 0xFF && r[1] === 0xAA));
  return io.ask([0x00, COMMAND, sub], isAnswer, WAIT_MS);
}

const awake = (reply) => reply !== null && reply[0] === COMMAND;

function mouseReader(scale) {
  return async (io) => {
    const r = await ask(io, MOUSE);
    return awake(r) ? reading(validPercent(r[4] * scale), r[9] !== 0) : [];
  };
}

function keyboardReader(atLevel) {
  return async (io) => {
    const r = await ask(io, KEYBOARD);
    return awake(r) ? reading(validPercent(r[atLevel]), r[8] === 1) : [];
  };
}

const mouse = (productIds, scale) => ({
  label: 'ROG wireless mouse', products: ids(ASUS, productIds), page: 0xFF01, usbInterface: 0, size: CHANNEL_BYTES, read: mouseReader(scale),
});
const keyboard = (label, productIds, atLevel) => ({
  label, products: ids(ASUS, productIds), page: 0xFF00, size: CHANNEL_BYTES, read: keyboardReader(atLevel),
});

module.exports = [
  mouse([0x1A1A, 0x1A18, 0x197F, 0x197D, 0x1A72, 0x1A70, 0x1B0C, 0x1B0A, 0x1A94, 0x1A92, 0x1B67, 0x1A68, 0x1A66, 0x1B16, 0x1979, 0x1977], 1),
  mouse([0x18E5, 0x18E3, 0x1960, 0x195E, 0x1A59, 0x1A57, 0x1908, 0x1906, 0x1949, 0x1947], GAUGE_STEP_PERCENT),
  keyboard('ROG wireless keyboard', [0x196B, 0x1A07], 5),
  keyboard('ROG Falchion RX', [0x1B04], 10),
];
