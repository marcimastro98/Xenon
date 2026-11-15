'use strict';
// Packet loss: the share of the echoes sent to 1.1.1.1 that never came back, over
// the newest WINDOW echoes. The network collectors already send three per reading
// for the ping; one reading of three could only ever say 0, 33, 67 or 100%.

const WINDOW = 60;

function createPacketLoss() {
  const lost = [];

  function add(sent, missed) {
    if (!Number.isInteger(sent) || !Number.isInteger(missed) || sent < 1 || missed < 0 || missed > sent) return;
    for (let i = 0; i < sent; i += 1) lost.push(i < missed ? 1 : 0);
    lost.splice(0, Math.max(0, lost.length - WINDOW));
  }

  function percent() {
    if (!lost.length) return null;
    return Math.round((lost.reduce((a, b) => a + b, 0) / lost.length) * 1000) / 10;
  }

  return { add, percent };
}

// iputils and BSD ping print the same summary line, but for "packets" before "received".
function parsePingCounts(out) {
  const m = String(out || '').match(/(\d+) packets transmitted, (\d+)(?: packets)? received/);
  if (!m) return null;
  const sent = Number(m[1]);
  const got = Number(m[2]);
  return sent > 0 && got <= sent ? { sent, lost: sent - got } : null;
}

// ping exits 1 or 2 when it ran and heard nothing back, which is what a dropped
// connection looks like. A missing binary or a timeout says nothing about the network.
function countsFromFailure(err, sent) {
  return err && (err.code === 1 || err.code === 2) ? { sent, lost: sent } : null;
}

module.exports = { createPacketLoss, parsePingCounts, countsFromFailure, WINDOW };
