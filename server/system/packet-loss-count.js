// The count of pings sent and lost that the network reading turns into a share of lost packets,
// made when the engine starts.

const { createPacketLoss } = require('./packet-loss.js');

const _packetLoss = createPacketLoss();

module.exports = { _packetLoss };
