'use strict';
// Ping and packet loss for the Game performance tile. Network readings cost a
// collector run, so they are only taken while someone chose to see them, at most
// once every `minGapMs`, and ride the system tick: no timer of their own, and
// nothing runs with no client connected. Unlike the frame rate they mean
// something outside a game, so this does not depend on one running.
//
// deps (injected):
//   read()       → Promise<{ ping, loss }>   (getNetworkInfo)
//   wanted()     → boolean
//   broadcast(d) → void

const MIN_GAP_MS = 5000;

function createPerfNet({ read, wanted, broadcast, minGapMs = MIN_GAP_MS, now = Date.now }) {
  let lastAt = -Infinity;
  let busy = false;
  let latest = { ping: null, loss: null, at: -Infinity };

  function send(d) {
    latest = { ...d, at: now() };
    broadcast(d);
  }

  async function tick() {
    if (busy || !wanted() || now() - lastAt < minGapMs) return;
    lastAt = now();
    busy = true;
    try {
      const d = await read();
      send({ ping: d.ping ?? null, loss: d.loss ?? null });
    } catch {
      // Said as "no reading": an old number would look like a live one.
      send({ ping: null, loss: null });
    } finally {
      busy = false;
    }
  }

  // The newest reading, for RivaTuner's line (server/rtss/); null once it is too old
  // to be the network now (no one has asked for a while).
  function last() {
    return now() - latest.at <= minGapMs * 3 ? { ping: latest.ping, loss: latest.loss } : null;
  }

  return { tick, last };
}

module.exports = { createPerfNet, MIN_GAP_MS };
